<?php
/* import.php — turn an uploaded Xero report (CSV) into stored periods.

   POST {csv, kind?}
     csv   — the raw text of a Xero CSV export.
     kind  — 'pl' | 'balance' | 'auto' (default 'auto'): what the file is.
   Returns a summary of what was parsed and merges it into the `finance` store.

   Xero's exports are semi-structured: a title block, then a header row naming
   the period column(s), then account rows grouped under section headers
   ("Trading Income", "Cost of Sales", "Operating Expenses", …) with "Total …"
   subtotals between them. We walk that structure rather than guessing per row.
   The parser is defensive — anything it cannot place is reported, never
   silently dropped — because an import you can't trust is worse than none. */
require __DIR__ . '/model.php';

$b = body_json();
$csv = (string) ($b['csv'] ?? '');
$kind = in_array($b['kind'] ?? 'auto', ['pl', 'balance', 'auto'], true) ? $b['kind'] : 'auto';
if (trim($csv) === '') fail('no CSV provided');

/* ---- Parse the raw text into rows of cells ---- */
$rows = [];
foreach (preg_split('/\r\n|\r|\n/', $csv) as $line) {
  if (trim($line) === '') { $rows[] = []; continue; }
  $rows[] = str_getcsv($line);
}
if (count($rows) < 2) fail('that does not look like a CSV export');

/* ---- Decide what report this is ---- */
$head = strtolower(implode(' ', array_map(fn($r) => implode(' ', $r), array_slice($rows, 0, 15))));
if ($kind === 'auto') {
  if (str_contains($head, 'balance sheet')) $kind = 'balance';
  else $kind = 'pl'; // default: profit & loss
}

/* Month labels, period parsing and the section classifier are shared with the
   Xero API sync — see classify.php (pulled in via model.php). */

function first_num(array $cells): ?float {
  foreach (array_slice($cells, 1) as $c) {
    $s = trim((string) $c);
    if ($s !== '' && preg_match('/\d/', $s)) return money_num($s);
  }
  return null;
}

$store = finance_store();

/* ============================================================
   Balance sheet
   ============================================================ */
if ($kind === 'balance') {
  $asAt = date('Y-m-d');
  if (preg_match('/as at\s+(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/i', $head, $m)) {
    $mon = MONTHS[strtolower(substr($m[2], 0, 3))] ?? '01';
    $asAt = sprintf('%04d-%s-%02d', (int) $m[3], $mon, (int) $m[1]);
  }
  $cash = null; $debtors = null; $creditors = null;
  // Prefer explicit "Total Bank"/"Total Cash"; fall back to any bank/cash row.
  foreach ($rows as $r) {
    if (!$r) continue;
    $name = strtolower(trim((string) ($r[0] ?? '')));
    $v = first_num($r);
    if ($v === null || $name === '') continue;
    if ($cash === null && preg_match('/^total (bank|cash)/', $name)) $cash = $v;
    elseif ($cash === null && preg_match('/\b(bank|cash at bank|cash)\b/', $name) && !str_contains($name, 'flow')) $cash = $v;
    if ($debtors === null && preg_match('/accounts receivable|trade debtors|^debtors|total receivables/', $name)) $debtors = $v;
    if ($creditors === null && preg_match('/accounts payable|trade creditors|^creditors|total payables/', $name)) $creditors = $v;
  }
  $store['balance'] = [
    'asAt' => $asAt,
    'cash' => $cash ?? 0.0,
    'debtors' => $debtors ?? 0.0,
    'creditors' => abs($creditors ?? 0.0),
    'source' => 'xero-bs',
    'importedAt' => time(),
  ];
  $store['updatedAt'] = time();
  store_write('finance', $store);
  respond([
    'ok' => true, 'kind' => 'balance',
    'summary' => [
      'asAt' => $asAt,
      'cash' => $store['balance']['cash'],
      'debtors' => $store['balance']['debtors'],
      'creditors' => $store['balance']['creditors'],
      'found' => array_values(array_filter([
        $cash !== null ? 'cash' : null, $debtors !== null ? 'debtors' : null, $creditors !== null ? 'creditors' : null,
      ])),
    ],
  ]);
}

/* ============================================================
   Profit & Loss  (section_bucket / is_subtotal live in classify.php)
   ============================================================ */

// Find the header row: the one whose cells 2+ parse as periods (or starts "Account").
$headerIdx = -1; $periodCols = [];
foreach ($rows as $i => $r) {
  if (count($r) < 2) continue;
  $cols = [];
  foreach (array_slice($r, 1) as $j => $c) {
    $pk = parse_period((string) $c);
    if ($pk) $cols[$j + 1] = $pk; // real column index
  }
  $c0 = strtolower(trim((string) ($r[0] ?? '')));
  if (count($cols) >= 1 && ($c0 === 'account' || $c0 === '' || $i <= 6)) {
    $headerIdx = $i; $periodCols = $cols; break;
  }
}
if ($headerIdx === -1 || !$periodCols) {
  fail('could not find the period columns — is this a Xero Profit & Loss export? (Try choosing the report type explicitly.)');
}

// Accumulate lines per period per bucket.
$acc = [];   // [periodKey][bucket][account] = amount
foreach ($periodCols as $pk) $acc[$pk] = ['income' => [], 'cogs' => [], 'opex' => [], 'otherIncome' => [], 'otherExpense' => []];

$bucket = null; $accounts = 0; $unplaced = [];
for ($i = $headerIdx + 1; $i < count($rows); $i++) {
  $r = $rows[$i];
  if (!$r) { continue; }
  $name = trim((string) ($r[0] ?? ''));
  if ($name === '') continue;

  $hasNums = first_num($r) !== null;
  // A section header: a label row with no figures on it.
  if (!$hasNums) {
    $sb = section_bucket($name);
    if ($sb) $bucket = $sb;
    continue;
  }
  if (is_subtotal($name)) continue;         // skip "Total …", "Gross Profit", …
  if ($bucket === null) { $unplaced[] = $name; continue; }

  foreach ($periodCols as $colIdx => $pk) {
    $cell = $r[$colIdx] ?? '';
    if (trim((string) $cell) === '') continue;
    $amt = money_num($cell);
    if ($amt === 0.0) continue;
    // Costs are stored as positive magnitudes so the model's subtraction is
    // unambiguous regardless of how Xero signed the export.
    if (in_array($bucket, ['cogs', 'opex', 'otherExpense'], true)) $amt = abs($amt);
    $acc[$pk][$bucket][$name] = ($acc[$pk][$bucket][$name] ?? 0) + $amt;
  }
  $accounts++;
}

// Merge into the store via the shared writer: each imported period REPLACES
// that month (re-importing a corrected export overwrites cleanly).
$importedPeriods = [];
foreach ($periodCols as $pk) {
  $period = finance_put_period($store, $pk, $acc[$pk], 'xero-pl');
  if ($period === null) continue;
  $t = period_totals($period);
  $importedPeriods[] = ['key' => $pk, 'label' => $period['label'], 'income' => $t['income'], 'netProfit' => $t['netProfit']];
}

if (!$importedPeriods) fail('found the columns but no account lines — check the export includes account rows, not just totals');

$store['updatedAt'] = time();
store_write('finance', $store);

respond([
  'ok' => true, 'kind' => 'pl',
  'summary' => [
    'periods' => $importedPeriods,
    'accounts' => $accounts,
    'unplaced' => array_values(array_unique($unplaced)),
  ],
]);
