<?php
/* xero-parse.php — turn Xero's Reports API JSON into our model.

   The Reports API returns a report as nested Rows: a Header row naming the
   period columns, then Sections (Title = "Income", "Less Cost of Sales", …)
   each holding leaf Rows (an account + a value per column) and SummaryRows
   (totals we skip). We reuse the SAME section classifier as the CSV importer
   (classify.php) so an API pull and a CSV upload produce identical months.

   Requires classify.php + config.php (money_num). */

/** Map the report's Header row cells to period keys, by column index. */
function xero_period_columns(array $rows): array {
  foreach ($rows as $row) {
    if (($row['RowType'] ?? '') !== 'Header') continue;
    $cols = [];
    foreach (($row['Cells'] ?? []) as $i => $cell) {
      if ($i === 0) continue; // first column is the account-name column
      $pk = parse_period((string) ($cell['Value'] ?? ''));
      if ($pk) $cols[$i] = $pk;
    }
    if ($cols) return $cols;
  }
  return [];
}

/**
 * Parse a ProfitAndLoss report.
 * @param array $unmapped  Filled with the titles of any account-bearing section
 *                         we couldn't classify, so callers can flag skipped
 *                         categories instead of losing them silently.
 * @return array [periodKey => [bucket => [account => amount]]]
 */
function xero_parse_pl(array $report, array &$unmapped = []): array {
  $rows = $report['Rows'] ?? [];
  $cols = xero_period_columns($rows);
  if (!$cols) return [];

  $acc = [];
  foreach ($cols as $pk) $acc[$pk] = ['income' => [], 'cogs' => [], 'opex' => [], 'otherIncome' => [], 'otherExpense' => []];

  foreach ($rows as $section) {
    if (($section['RowType'] ?? '') !== 'Section') continue;
    $title = trim((string) ($section['Title'] ?? ''));
    $bucket = section_bucket($title);
    if ($bucket === null) {
      // A titled section we couldn't place. Record it ONLY if it actually holds
      // account rows and isn't a computed summary block (Gross/Net/Operating
      // Profit) — those are meant to be skipped, not warned about.
      if ($title !== '' && !preg_match('/(gross|net|operating) profit|profit for the|net income/i', $title)) {
        foreach (($section['Rows'] ?? []) as $r) {
          if (($r['RowType'] ?? '') === 'Row') { $unmapped[] = $title; break; }
        }
      }
      continue; // e.g. an untitled or "Gross Profit" section
    }
    foreach (($section['Rows'] ?? []) as $r) {
      if (($r['RowType'] ?? '') !== 'Row') continue; // skip SummaryRow totals
      $cells = $r['Cells'] ?? [];
      $name = trim((string) ($cells[0]['Value'] ?? ''));
      if ($name === '' || is_subtotal($name)) continue;
      foreach ($cols as $idx => $pk) {
        $raw = $cells[$idx]['Value'] ?? '';
        if (trim((string) $raw) === '') continue;
        $amt = money_num($raw);
        if ($amt === 0.0) continue;
        $acc[$pk][$bucket][$name] = ($acc[$pk][$bucket][$name] ?? 0) + $amt;
      }
    }
  }
  return $acc;
}

/**
 * Parse a BalanceSheet report into the snapshot we keep.
 * @return array{asAt:string,cash:float,debtors:float,creditors:float}
 */
function xero_parse_bs(array $report): array {
  $rows = $report['Rows'] ?? [];
  $cols = xero_period_columns($rows);
  $valIdx = $cols ? array_key_first($cols) : 1; // the most recent column
  $asAt = date('Y-m-d');
  // Report date, if present, e.g. "ReportDate":"30 September 2025".
  if (preg_match('/(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/', (string) ($report['ReportDate'] ?? ''), $m)) {
    $mon = MONTHS[strtolower(substr($m[2], 0, 3))] ?? '01';
    $asAt = sprintf('%04d-%s-%02d', (int) $m[3], $mon, (int) $m[1]);
  }

  $cash = null; $debtors = null; $creditors = null;
  $walk = function ($rows) use (&$walk, &$cash, &$debtors, &$creditors, $valIdx) {
    foreach ($rows as $r) {
      if (!empty($r['Rows'])) { $walk($r['Rows']); }
      $cells = $r['Cells'] ?? [];
      if (!$cells) continue;
      $name = strtolower(trim((string) ($cells[0]['Value'] ?? '')));
      $val = money_num($cells[$valIdx]['Value'] ?? ($cells[count($cells) - 1]['Value'] ?? ''));
      if ($name === '') continue;
      if ($cash === null && preg_match('/^total (bank|cash)/', $name)) $cash = $val;
      elseif ($cash === null && preg_match('/\b(bank|cash at bank)\b/', $name) && !str_contains($name, 'flow')) $cash = $val;
      if ($debtors === null && preg_match('/accounts receivable|trade debtors|^debtors|total receivables/', $name)) $debtors = $val;
      if ($creditors === null && preg_match('/accounts payable|trade creditors|^creditors|total payables/', $name)) $creditors = $val;
    }
  };
  $walk($rows);

  return [
    'asAt' => $asAt,
    'cash' => (float) ($cash ?? 0),
    'debtors' => (float) ($debtors ?? 0),
    'creditors' => abs((float) ($creditors ?? 0)),
  ];
}
