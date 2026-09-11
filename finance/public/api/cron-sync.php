<?php
/* cron-sync.php — the automated daily job. Run from cron as the account user:
 *
 *   /usr/local/bin/php /home/wwwdfootdigi/public_html/reports.digital-footprints.co.uk/finance/api/cron-sync.php
 *
 * It (0) emails the Monday brief (the stored bank digest — position, pace,
 * open questions, who's gone quiet) when 'digest_to' is set in
 * claude-config.php (pass --digest to force-send for testing), then (1) pulls
 * the last 12 months of P&L + the balance sheet + outstanding invoices from
 * Xero, exactly as the Import → Sync button does, then (2) auto-writes the
 * board report for the most recent COMPLETED month, once — so daily runs keep
 * the figures fresh without piling up a new AI board pack every day.
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

/* ---- 0) Monday digest email ----
   Runs FIRST so a broken Xero connection never blocks the brief. Sends on
   Mondays (or any run with --digest, for testing), once per day, to the
   optional 'digest_to' in claude-config.php. The body is the stored bank
   digest — the same compact brief that grounds "Ask the data": position,
   month pace, client patterns, loans, open questions, filed decisions. */
function cron_send_digest(bool $forced): void {
  $ccFile = __DIR__ . '/claude-config.php';
  $cc = is_file($ccFile) ? include $ccFile : null;
  $to = is_array($cc) ? trim((string) ($cc['digest_to'] ?? '')) : '';
  if ($to === '') { if ($forced) cron_log("Digest skipped: no 'digest_to' in api/claude-config.php."); return; }
  if (!$forced && date('N') !== '1') return;   // Mondays only unless --digest

  $cron = store_read('cron', []);
  if (!$forced && ($cron['lastDigestDay'] ?? '') === date('Y-m-d')) {
    cron_log('Digest already sent today — skipping.');
    return;
  }

  $bank = store_read('bank', []);
  $digest = trim((string) ($bank['digest'] ?? ''));
  if ($digest === '') { cron_log('Digest skipped: no bank digest stored yet (import a statement).'); return; }

  $from = trim((string) ($cc['digest_from'] ?? ''));
  if ($from === '') $from = 'finance@' . (preg_replace('/^www\./', '', (string) gethostname()) ?: 'localhost');

  $subject = 'Finance HQ — Monday brief (' . date('j M Y') . ')';
  $body = "Your Monday brief from Finance HQ — the week's position, who's gone quiet,\n"
    . "and the questions the data is raising. Open the dashboard to file decisions.\n\n"
    . $digest . "\n\n--\nSent by the daily cron (api/cron-sync.php). "
    . "To stop these, remove 'digest_to' from api/claude-config.php.\n";
  $headers = "From: Finance HQ <$from>\r\nContent-Type: text/plain; charset=UTF-8";

  if (@mail($to, $subject, $body, $headers)) {
    $cron['lastDigestDay'] = date('Y-m-d');
    store_write('cron', $cron);
    cron_log("Digest emailed to $to.");
  } else {
    cron_log("ERROR: digest email to $to failed (PHP mail()).");
  }
}

cron_send_digest(in_array('--digest', $argv ?? [], true));

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
