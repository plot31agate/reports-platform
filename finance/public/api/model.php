<?php
/* model.php — the shared financial model.

   One definition of "the numbers" that finance.php serves to the dashboard and
   that ask.php / forecast.php feed to Claude, so a KPI is computed exactly once
   and every surface agrees. Pure functions over the `finance` store; no output.

   A period is one month, keyed YYYY-MM. Its P&L is grouped into the standard
   buckets so gross and net profit are unambiguous:
     income        — trading income (sales)
     cogs          — cost of sales / direct costs
     opex          — operating expenses (overheads: marketing, salaries, …)
     otherIncome   — non-trading income (interest, grants)
     otherExpense  — non-operating costs (interest, depreciation, tax)
   grossProfit = income − cogs
   netProfit   = grossProfit − opex + otherIncome − otherExpense */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/classify.php';

const PL_BUCKETS = ['income', 'cogs', 'opex', 'otherIncome', 'otherExpense'];

/** Write one month into a finance store from a bucket->(account=>amount) map,
    replacing any existing figures for that month (a corrected re-import or a
    fresh sync overwrites cleanly rather than doubling up). Costs are stored as
    positive magnitudes so the model's subtraction is unambiguous. Mutates and
    returns $store; returns null via the caller when the month is empty.
    Shared by the CSV importer and the Xero API sync. */
function finance_put_period(array &$store, string $key, array $buckets, string $source): ?array {
  $period = ['label' => month_label($key), 'source' => $source, 'importedAt' => time()];
  $any = false;
  foreach (PL_BUCKETS as $bk) {
    $period[$bk] = [];
    foreach ($buckets[$bk] ?? [] as $account => $amount) {
      $amount = (in_array($bk, ['cogs', 'opex', 'otherExpense'], true)) ? abs($amount) : $amount;
      if ($amount === 0.0) continue;
      $period[$bk][] = ['account' => (string) $account, 'amount' => round((float) $amount, 2)];
      $any = true;
    }
  }
  if (!$any) return null;
  $store['periods'][$key] = $period;
  return $period;
}

function finance_store(): array {
  $s = store_read('finance', ['periods' => [], 'balance' => null]);
  if (!isset($s['periods']) || !is_array($s['periods'])) $s['periods'] = [];
  return $s;
}

/** Sum a bucket's line items. */
function bucket_sum(array $period, string $bucket): float {
  $t = 0.0;
  foreach ($period[$bucket] ?? [] as $line) $t += (float) ($line['amount'] ?? 0);
  return $t;
}

/** Fully-computed totals for one stored period. */
function period_totals(array $p): array {
  $income = bucket_sum($p, 'income');
  $cogs = bucket_sum($p, 'cogs');
  $opex = bucket_sum($p, 'opex');
  $oi = bucket_sum($p, 'otherIncome');
  $oe = bucket_sum($p, 'otherExpense');
  $gross = $income - $cogs;
  $net = $gross - $opex + $oi - $oe;
  return [
    'income' => $income, 'cogs' => $cogs, 'grossProfit' => $gross,
    'opex' => $opex, 'otherIncome' => $oi, 'otherExpense' => $oe,
    'netProfit' => $net,
    'grossMargin' => $income > 0 ? $gross / $income * 100 : null,
    'netMargin' => $income > 0 ? $net / $income * 100 : null,
  ];
}

/** The full model: sorted periods with totals + line detail, latest KPIs with
    month-on-month deltas, and the balance snapshot. */
function finance_model(): array {
  $store = finance_store();
  $keys = array_keys($store['periods']);
  sort($keys); // YYYY-MM sorts chronologically as strings

  $periods = [];
  foreach ($keys as $k) {
    $p = $store['periods'][$k];
    $t = period_totals($p);
    $periods[] = [
      'key' => $k,
      'label' => $p['label'] ?? $k,
      'source' => $p['source'] ?? '',
      'importedAt' => (int) ($p['importedAt'] ?? 0),
      'totals' => $t,
      'income' => array_values($p['income'] ?? []),
      'cogs' => array_values($p['cogs'] ?? []),
      'opex' => array_values($p['opex'] ?? []),
      'otherIncome' => array_values($p['otherIncome'] ?? []),
      'otherExpense' => array_values($p['otherExpense'] ?? []),
    ];
  }

  $n = count($periods);
  $latest = $n > 0 ? $periods[$n - 1] : null;
  $prev = $n > 1 ? $periods[$n - 2] : null;

  return [
    'currency' => BASE_CURRENCY,
    'jurisdiction' => JURISDICTION,
    'periods' => $periods,
    'meta' => [
      'count' => $n,
      'first' => $n > 0 ? $periods[0]['key'] : null,
      'last' => $n > 0 ? $periods[$n - 1]['key'] : null,
    ],
    'latest' => $latest,
    'previous' => $prev,
    'balance' => $store['balance'] ?? null,
  ];
}

/** A compact, token-light view of the model for a Claude prompt: monthly
    totals plus the latest month's line-level detail and the balance. */
function finance_brief(int $months = 12): string {
  $m = finance_model();
  if ($m['meta']['count'] === 0) return "No financial data has been imported yet.";

  $lines = ["Currency: GBP. All figures £. Jurisdiction: United Kingdom."];
  $lines[] = "";
  $lines[] = "Monthly P&L totals (income / cost of sales / gross profit / overheads / net profit):";
  $periods = array_slice($m['periods'], -$months);
  foreach ($periods as $p) {
    $t = $p['totals'];
    $lines[] = sprintf(
      "  %s: income %.0f, COGS %.0f, gross %.0f, overheads %.0f, net %.0f",
      $p['label'], $t['income'], $t['cogs'], $t['grossProfit'], $t['opex'], $t['netProfit']
    );
  }

  if ($m['latest']) {
    $lines[] = "";
    $lines[] = "Latest month (" . $m['latest']['label'] . ") detail:";
    foreach (['income' => 'Income', 'cogs' => 'Cost of sales', 'opex' => 'Overheads', 'otherExpense' => 'Other costs'] as $b => $lbl) {
      $rows = $m['latest'][$b] ?? [];
      if (!$rows) continue;
      $lines[] = "  $lbl:";
      foreach ($rows as $r) {
        $lines[] = sprintf("    - %s: %.0f", $r['account'] ?? '?', (float) ($r['amount'] ?? 0));
      }
    }
  }

  if (!empty($m['balance'])) {
    $b = $m['balance'];
    $lines[] = "";
    $lines[] = "Balance sheet (as at " . ($b['asAt'] ?? '?') . "):";
    $lines[] = sprintf(
      "  cash %.0f, money owed to us (debtors) %.0f, money we owe (creditors) %.0f",
      (float) ($b['cash'] ?? 0), (float) ($b['debtors'] ?? 0), (float) ($b['creditors'] ?? 0)
    );
  }
  return implode("\n", $lines);
}
