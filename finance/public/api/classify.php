<?php
/* classify.php — the shared understanding of a Profit & Loss report, used by
   BOTH importers: the CSV upload (import.php) and the live Xero API sync
   (xero.php). One place decides what a period label means and which bucket a
   section belongs to, so a CSV export and an API pull produce identical months.

   Requires config.php (money_num) to be loaded first. */

/* Month-label -> YYYY-MM. */
const MONTHS = [
  'jan' => '01', 'feb' => '02', 'mar' => '03', 'apr' => '04', 'may' => '05', 'jun' => '06',
  'jul' => '07', 'aug' => '08', 'sep' => '09', 'oct' => '10', 'nov' => '11', 'dec' => '12',
];
const MONTH_NAMES = [
  '01' => 'Jan', '02' => 'Feb', '03' => 'Mar', '04' => 'Apr', '05' => 'May', '06' => 'Jun',
  '07' => 'Jul', '08' => 'Aug', '09' => 'Sep', '10' => 'Oct', '11' => 'Nov', '12' => 'Dec',
];

/** "Jul 2025", "July 2025", "31 Jul 2025", "Jul-25", "2025-07" -> "2025-07". */
function parse_period(string $s): ?string {
  $s = trim($s);
  if ($s === '') return null;
  if (preg_match('/^(\d{4})-(\d{2})$/', $s, $m) && (int) $m[2] >= 1 && (int) $m[2] <= 12) return "$m[1]-$m[2]";
  if (preg_match('/([a-zA-Z]{3,})[ \-]*(\d{2,4})/', $s, $m)) {
    $mon = MONTHS[strtolower(substr($m[1], 0, 3))] ?? null;
    if ($mon === null) return null;
    $yr = $m[2];
    if (strlen($yr) === 2) $yr = '20' . $yr;
    return "$yr-$mon";
  }
  return null;
}

/** "2025-07" -> "Jul 2025". */
function month_label(string $key): string {
  if (!preg_match('/^(\d{4})-(\d{2})$/', $key, $m)) return $key;
  return (MONTH_NAMES[$m[2]] ?? $m[2]) . ' ' . $m[1];
}

/* Section header -> bucket. Ordered: most specific first, first match wins.
   Covers the wording of both Xero's CSV exports and its Reports API JSON
   (which prefixes cost sections with "Less " and income with "Plus "). */
function section_bucket(string $name): ?string {
  $n = strtolower(trim($name));
  if ($n === '') return null;
  if (preg_match('/cost of (sales|goods)|direct costs/', $n)) return 'cogs';
  if (preg_match('/other income|interest received|non-operating income/', $n)) return 'otherIncome';
  if (preg_match('/other expense|depreciation|amortis|taxation|interest paid|finance costs/', $n)) return 'otherExpense';
  if (preg_match('/operating expense|overhead|administrative expense|less operating|^expenses?$/', $n)) return 'opex';
  if (preg_match('/trading income|revenue|turnover|^income$|^sales$/', $n)) return 'income';
  return null;
}

/** Computed subtotals and report chrome — never treated as accounts. */
function is_subtotal(string $name): bool {
  $n = strtolower(trim($name));
  return $n === '' || str_starts_with($n, 'total ')
    || (bool) preg_match('/^(gross profit|net profit|operating profit|profit for the|net income)/', $n);
}
