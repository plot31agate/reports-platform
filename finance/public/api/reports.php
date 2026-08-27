<?php
/* reports.php — board reports: a Claude-written board pack over the imported
   figures, stored so it can be handed to a director via a read-only share link
   (board.php) without a Finance HQ login.

   The numbers are computed here in PHP (one source of truth) and BOTH fed to
   Claude for commentary AND stored on the report, so the share page renders the
   exact figures the model reasoned about — the model narrates, it never supplies
   the KPIs.

   GET               -> list stored reports (id, period, title, when, shareUrl)
   GET ?id=<id>      -> one full report + shareUrl
   POST {action:generate, month}  -> compute KPIs, write the narrative, store
   POST {action:delete, id} */
require_once __DIR__ . '/claude.php';
require_once __DIR__ . '/model.php';

function board_store(): array {
  $s = store_read('board', ['reports' => []]);
  if (!isset($s['reports']) || !is_array($s['reports'])) $s['reports'] = [];
  return $s;
}

/** The base URL of the deployed app (…/finance), derived from the request so no
    site URL needs configuring. */
function app_base_url(): string {
  $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
  $scheme = $https ? 'https' : 'http';
  $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
  $dir = str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/finance/api/reports.php')));
  return $scheme . '://' . $host . rtrim($dir, '/');
}

function share_url(string $id): string {
  $t = board_token($id);
  return $t === '' ? '' : app_base_url() . '/board.php?id=' . rawurlencode($id) . '&t=' . $t;
}

/** The computed KPI snapshot for a month: the figures the board pack reports. */
function board_kpis(array $model, string $month): ?array {
  $cur = null; $curIdx = -1;
  foreach ($model['periods'] as $i => $p) if ($p['key'] === $month) { $cur = $p; $curIdx = $i; break; }
  if (!$cur) return null;
  $prev = $curIdx > 0 ? $model['periods'][$curIdx - 1] : null;
  $t = $cur['totals'];
  $pt = $prev['totals'] ?? null;

  // Trailing average net (up to 3 months to this one) for the runway read.
  $window = array_slice($model['periods'], max(0, $curIdx - 2), min(3, $curIdx + 1));
  $avgNet = 0.0; foreach ($window as $w) $avgNet += $w['totals']['netProfit'];
  $avgNet = $window ? $avgNet / count($window) : 0.0;

  $bal = $model['balance'];
  $cash = $bal['cash'] ?? null;
  $runway = ($cash !== null && $avgNet < 0) ? $cash / -$avgNet : null;

  $mkDelta = fn($c, $p) => $p === null ? null : ['abs' => $c - $p, 'pct' => $p != 0 ? ($c - $p) / abs($p) * 100 : null];

  return [
    'revenue' => $t['income'], 'grossProfit' => $t['grossProfit'], 'netProfit' => $t['netProfit'],
    'cogs' => $t['cogs'], 'opex' => $t['opex'],
    'grossMargin' => $t['grossMargin'], 'netMargin' => $t['netMargin'],
    'cash' => $cash, 'debtors' => $bal['debtors'] ?? null, 'creditors' => $bal['creditors'] ?? null,
    'balanceAsAt' => $bal['asAt'] ?? null,
    'avgNet' => round($avgNet, 2), 'runwayMonths' => $runway !== null ? round($runway, 1) : null,
    'prevLabel' => $prev['label'] ?? null,
    'revenueDelta' => $mkDelta($t['income'], $pt['income'] ?? null),
    'netDelta' => $mkDelta($t['netProfit'], $pt['netProfit'] ?? null),
    'costDelta' => $mkDelta($t['cogs'] + $t['opex'], $pt ? $pt['cogs'] + $pt['opex'] : null),
  ];
}

/* Board-pack generation, factored out so the web POST route AND the CLI cron
   (cron-sync.php) build reports identically: compute the KPI snapshot, have
   Claude write the narrative anchored to it, store it, return the report. Pass
   a month (YYYY-MM) or null for the latest. Exits via fail()/respond() on error
   or a missing Claude key. */
function board_generate(?string $month = null): array {
  $store = board_store();
  $model = finance_model();
  if ($model['meta']['count'] === 0) fail('Import a Xero report first — there is nothing to report on yet.');
  $month = ($month !== null && $month !== '') ? $month : (string) $model['meta']['last'];
  $kpis = board_kpis($model, $month);
  if (!$kpis) fail('no data for that month');

  $periodLabel = month_label($month);
  $brief = finance_brief();

  // The figures, spelled out for the prompt so commentary is anchored to them.
  $fig = fn($v) => $v === null ? 'n/a' : '£' . number_format((float) $v, 0);
  $revDelta = $kpis['revenueDelta'] ? sprintf(' (%+.1f%% vs %s)', $kpis['revenueDelta']['pct'] ?? 0, $kpis['prevLabel']) : '';
  $netDelta = $kpis['netDelta'] ? sprintf(' (%+.1f%% vs %s)', $kpis['netDelta']['pct'] ?? 0, $kpis['prevLabel']) : '';
  $runwayTxt = $kpis['runwayMonths'] !== null ? ", cash runway ~{$kpis['runwayMonths']} months" : ', cash-positive';
  $figures = "Computed figures for $periodLabel (comment on these; do not restate different numbers):\n"
    . '  Revenue: ' . $fig($kpis['revenue']) . $revDelta . "\n"
    . '  Gross profit: ' . $fig($kpis['grossProfit']) . " ({$kpis['grossMargin']}% margin)\n"
    . '  Net profit: ' . $fig($kpis['netProfit']) . $netDelta . "\n"
    . '  Overheads: ' . $fig($kpis['opex']) . ', Cost of sales: ' . $fig($kpis['cogs']) . "\n"
    . '  Cash: ' . $fig($kpis['cash']) . ', owed to us: ' . $fig($kpis['debtors']) . ', we owe: ' . $fig($kpis['creditors']) . "\n"
    . '  Recent average net/month: ' . $fig($kpis['avgNet']) . $runwayTxt . "\n";

  $schema = [
    'type' => 'object',
    'properties' => [
      'title' => ['type' => 'string', 'description' => "A board-pack title, e.g. 'Board Report — $periodLabel'."],
      'summary' => ['type' => 'string', 'description' => 'Executive summary: 3–5 sentences a director reads first.'],
      'performance' => ['type' => 'string', 'description' => 'What drove revenue and profit this period, vs the prior month.'],
      'costs' => ['type' => 'string', 'description' => 'Cost & efficiency commentary: where money went, what moved.'],
      'cashPosition' => ['type' => 'string', 'description' => 'Cash, receivables, payables and runway in plain terms.'],
      'risks' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => '3–5 risks / watch items.'],
      'recommendations' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => '3–5 decisions/actions for the board.'],
      'taxNote' => ['type' => 'string', 'description' => 'A short UK tax & compliance note (Corporation Tax/VAT), flagged as an estimate to confirm with the accountant.'],
      'outlook' => ['type' => 'string', 'description' => 'Forward look for the coming month/quarter.'],
    ],
    'required' => ['title', 'summary', 'performance', 'costs', 'cashPosition', 'risks', 'recommendations', 'taxNote', 'outlook'],
    'additionalProperties' => false,
  ];

  $user = "Write the board report for Digital Footprints for $periodLabel.\n\n$figures\n\n"
    . "Full data for context:\n$brief\n\n"
    . "Write for the board: crisp, honest about dips, quantified in £. This is a UK "
    . "limited company. Keep the tax note brief and clearly an estimate.";

  $narrative = claude_json(claude_system(), $user, $schema, 2600);

  $id = bin2hex(random_bytes(8));
  $report = [
    'id' => $id,
    'period' => $month,
    'periodLabel' => $periodLabel,
    'title' => (string) $narrative['title'],
    'generatedAt' => time(),
    'kpis' => $kpis,
    'narrative' => $narrative,
  ];
  $store['reports'][] = $report;
  $store['updatedAt'] = time();
  store_write('board', $store);
  return $report;
}

// Everything below is HTTP request routing; the CLI cron only needs the
// functions above.
if (PHP_SAPI === 'cli') return;

/* ---- Routes ---- */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $store = board_store();
  if (isset($_GET['id'])) {
    foreach ($store['reports'] as $r) {
      if ($r['id'] === $_GET['id']) respond(['ok' => true, 'report' => $r, 'shareUrl' => share_url($r['id'])]);
    }
    fail('not found', 404);
  }
  // List, newest first.
  $list = array_map(fn($r) => [
    'id' => $r['id'], 'period' => $r['period'], 'periodLabel' => $r['periodLabel'],
    'title' => $r['title'], 'generatedAt' => $r['generatedAt'], 'shareUrl' => share_url($r['id']),
  ], $store['reports']);
  usort($list, fn($a, $b) => $b['generatedAt'] <=> $a['generatedAt']);
  respond(['ok' => true, 'reports' => $list]);
}

$b = body_json();
$action = $b['action'] ?? '';
$store = board_store();

if ($action === 'delete') {
  $id = (string) ($b['id'] ?? '');
  $before = count($store['reports']);
  $store['reports'] = array_values(array_filter($store['reports'], fn($r) => $r['id'] !== $id));
  if (count($store['reports']) === $before) fail('not found', 404);
  store_write('board', $store);
  respond(['ok' => true]);
}

if ($action !== 'generate') fail('unknown action');

$report = board_generate($b['month'] ?? null);
respond(['ok' => true, 'report' => $report, 'shareUrl' => share_url($report['id'])]);
