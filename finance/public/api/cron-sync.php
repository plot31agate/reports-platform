<?php
/* cron-sync.php — the automated daily job. Run from cron as the account user:
 *
 *   /usr/local/bin/php /home/wwwdfootdigi/public_html/reports.digital-footprints.co.uk/finance/api/cron-sync.php
 *
 * It (1) pulls the last 12 months of P&L + the balance sheet from Xero, exactly
 * as the Import → Sync button does, then (2) auto-writes the board report for
 * the most recent COMPLETED month, once — so daily runs keep the figures fresh
 * without piling up a new AI board pack every day.
 *
 * CLI-only: it refuses to run over the web (and it sits behind Basic Auth in the
 * api/ folder anyway). It reuses the exact sync + report code the UI uses, so an
 * automatic pull and a manual one produce identical months.
 *
 * Prerequisites (one-time, by hand): api/xero-config.php + api/claude-config.php
 * uploaded, and Xero connected once in the browser (Import → Connect Xero) to
 * seed the refresh token. After that this runs unattended; the refresh token
 * rotates on each run and stays valid as long as the job runs within any 60-day
 * window. */

if (PHP_SAPI !== 'cli') {
  http_response_code(403);
  header('Content-Type: text/plain');
  exit("cron-sync.php is a command-line job, not a web endpoint.\n");
}

require_once __DIR__ . '/xero.php';     // defines xero_run_sync(); returns before its web routes
require_once __DIR__ . '/reports.php';  // defines board_generate(); returns before its web routes

function cron_log(string $msg): void {
  fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . '] ' . $msg . "\n");
}

/* ---- 1) Pull from Xero ---- */
$cfg = xero_cfg();
if (!$cfg) { cron_log('ERROR: api/xero-config.php is missing or incomplete.'); exit(1); }

$store = xero_store();
if (empty($store['connected'])) {
  cron_log('ERROR: Xero is not connected. Do Import → Connect Xero once in the browser, then this runs unattended.');
  exit(1);
}

$summary = xero_run_sync($store, $cfg);   // fail() exits with a JSON error on a Xero/token problem
cron_log('Xero pull OK: ' . count($summary['periods']) . ' month(s) from ' . ($store['tenantName'] ?? 'Xero') . '.');

/* ---- 2) Board report for the latest COMPLETED month, once ---- */
$model = finance_model();
$currentMonth = date('Y-m');
$target = null;
foreach ($model['periods'] as $p) {
  if ($p['key'] < $currentMonth) $target = $p['key'];   // periods are sorted; keep the latest closed one
}

if ($target === null) {
  cron_log('No completed month to report on yet — skipping board report.');
  cron_log('done');
  exit(0);
}

$exists = false;
foreach (board_store()['reports'] as $r) {
  if (($r['period'] ?? '') === $target) { $exists = true; break; }
}

if ($exists) {
  cron_log("Board report for $target already exists — leaving it. done");
  exit(0);
}

$report = board_generate($target);
cron_log('Board report generated: ' . $report['periodLabel'] . ' (' . $report['id'] . ').');
cron_log('done');
