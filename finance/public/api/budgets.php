<?php
/* budgets.php — spend layers: "here's what we should be spending on X", checked
   against what Xero actually shows.

   A layer names a spend area (Marketing, Salaries, …), a monthly budget, and a
   set of match tokens. The tokens are matched (case-insensitive substring)
   against the cost account names in a chosen month; their sum is the actual.
   variance = actual − budget; a layer is under / near / over accordingly.

   GET ?month=YYYY-MM (default: latest imported month)
       -> layers with actuals+variance for that month, plus the month's cost
          account names (so the UI can help wire up match tokens).
   POST {action: add|update|delete|seed} */
require __DIR__ . '/model.php';

const NEAR_BAND = 0.10; // within 10% of budget reads as "near", not over/under

function budgets_store(): array {
  $s = store_read('budgets', ['layers' => []]);
  if (!isset($s['layers']) || !is_array($s['layers'])) $s['layers'] = [];
  return $s;
}

/** All cost line items (account => amount) for a period key, across the cost
    buckets, so a layer can match against any of them. */
function period_costs(string $key): array {
  $m = finance_model();
  foreach ($m['periods'] as $p) {
    if ($p['key'] !== $key) continue;
    $out = [];
    foreach (['cogs', 'opex', 'otherExpense'] as $bk) {
      foreach ($p[$bk] as $line) {
        $out[(string) $line['account']] = ($out[(string) $line['account']] ?? 0) + (float) $line['amount'];
      }
    }
    return $out;
  }
  return [];
}

/** Actual spend for a layer in one month: sum of cost lines whose name
    contains any of the layer's match tokens. */
function layer_actual(array $costs, array $tokens): float {
  if (!$tokens) return 0.0;
  $t = 0.0;
  foreach ($costs as $account => $amount) {
    $a = strtolower($account);
    foreach ($tokens as $tok) {
      if ($tok !== '' && str_contains($a, $tok)) { $t += $amount; break; }
    }
  }
  return $t;
}

function tokens_of($match): array {
  $parts = is_array($match) ? $match : explode(',', (string) $match);
  $out = [];
  foreach ($parts as $p) { $p = strtolower(trim((string) $p)); if ($p !== '') $out[] = $p; }
  return $out;
}

function clean_layer(array $src): array {
  return [
    'name' => mb_substr(trim((string) ($src['name'] ?? '')), 0, 80),
    'match' => mb_substr(trim((string) (is_array($src['match'] ?? null) ? implode(', ', $src['match']) : ($src['match'] ?? ''))), 0, 300),
    'monthly' => max(0, money_num($src['monthly'] ?? 0)),
    'note' => mb_substr(trim((string) ($src['note'] ?? '')), 0, 200),
  ];
}

/* Default layers — the overheads most agencies watch. Seeded on request; match
   tokens are best-effort and meant to be tuned against the real accounts. */
const LAYER_LIBRARY = [
  ['name' => 'Marketing', 'match' => 'advertising, marketing, ads, promotion', 'monthly' => 0],
  ['name' => 'Salaries & wages', 'match' => 'wages, salaries, payroll, employer', 'monthly' => 0],
  ['name' => 'Contractors', 'match' => 'subcontractor, contractor, freelance', 'monthly' => 0],
  ['name' => 'Software & tools', 'match' => 'software, subscriptions, saas, hosting', 'monthly' => 0],
  ['name' => 'Office & premises', 'match' => 'rent, rates, office, utilities', 'monthly' => 0],
  ['name' => 'Professional fees', 'match' => 'accountancy, legal, professional', 'monthly' => 0],
];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $model = finance_model();
  $month = (string) ($_GET['month'] ?? ($model['meta']['last'] ?? ''));
  $costs = $month !== '' ? period_costs($month) : [];
  $store = budgets_store();

  $layers = [];
  foreach ($store['layers'] as $l) {
    $tokens = tokens_of($l['match'] ?? '');
    $actual = layer_actual($costs, $tokens);
    $budget = (float) ($l['monthly'] ?? 0);
    $variance = $actual - $budget;
    $status = 'under';
    if ($budget > 0) {
      if ($actual > $budget * (1 + NEAR_BAND)) $status = 'over';
      elseif ($actual >= $budget * (1 - NEAR_BAND)) $status = 'near';
    } elseif ($actual > 0) {
      $status = 'over'; // spending with no budget set
    }
    $layers[] = $l + ['actual' => round($actual, 2), 'variance' => round($variance, 2), 'status' => $status];
  }

  respond([
    'ok' => true,
    'month' => $month,
    'monthLabel' => $model['latest'] && $model['latest']['key'] === $month ? $model['latest']['label'] : $month,
    'layers' => $layers,
    'accounts' => array_keys($costs),
    'totalBudget' => array_sum(array_map(fn($l) => (float) ($l['monthly'] ?? 0), $store['layers'])),
    'totalActual' => array_sum(array_map(fn($l) => $l['actual'], $layers)),
  ]);
}

$b = body_json();
$store = budgets_store();
$action = $b['action'] ?? '';

switch ($action) {
  case 'add': {
    $l = clean_layer($b);
    if ($l['name'] === '') fail('name required');
    $l['id'] = bin2hex(random_bytes(6));
    $store['layers'][] = $l;
    $store['updatedAt'] = time();
    store_write('budgets', $store);
    respond(['ok' => true, 'layer' => $l]);
  }
  case 'update': {
    $id = (string) ($b['id'] ?? '');
    $found = false;
    foreach ($store['layers'] as &$l) {
      if (($l['id'] ?? '') === $id) { $l = clean_layer(array_merge($l, $b)) + ['id' => $id]; $found = true; break; }
    }
    unset($l);
    if (!$found) fail('not found', 404);
    $store['updatedAt'] = time();
    store_write('budgets', $store);
    respond(['ok' => true]);
  }
  case 'delete': {
    $before = count($store['layers']);
    $store['layers'] = array_values(array_filter($store['layers'], fn($l) => ($l['id'] ?? '') !== ($b['id'] ?? '')));
    if (count($store['layers']) === $before) fail('not found', 404);
    $store['updatedAt'] = time();
    store_write('budgets', $store);
    respond(['ok' => true]);
  }
  case 'seed': {
    if (count($store['layers']) > 0) respond(['ok' => true, 'seeded' => 0]);
    foreach (LAYER_LIBRARY as $lib) {
      $store['layers'][] = clean_layer($lib) + ['id' => bin2hex(random_bytes(6))];
    }
    $store['updatedAt'] = time();
    store_write('budgets', $store);
    respond(['ok' => true, 'seeded' => count($store['layers'])]);
  }
}
fail('unknown action');
