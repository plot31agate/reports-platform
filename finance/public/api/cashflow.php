<?php
/* cashflow.php — the 13-week rolling cash forecast.

   GET  -> { ok, weeks:[…], headline:{…}, settings:{…}, payments:[…],
            receipts:[…], included:[…] }
   POST {action}:
     settings {totalCash?, vatSetAside?}     — opening bank + ring-fenced VAT pot
     add      {kind:'payment'|'receipt', label, amount, cadence, date?, until?, category?, client?, note?}
     update   {kind, id, …fields}
     delete   {kind, id}

   Receipts and payments are the manual, forward-dated obligations Xero can't
   future-date (HMRC Time-to-Pay, CCS, VAT, PAYE, lease, payroll, contractors)
   plus any expected income. Won pipeline work is folded in automatically by
   planning.php; open pipeline can be toggled into the scenario line there. */
require __DIR__ . '/planning.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  respond(['ok' => true] + cashflow_compute());
}

$b = body_json();
$store = cashflow_store();
$action = $b['action'] ?? '';

/** payments|receipts list name for a request 'kind'. */
function cf_list(string $kind): string { return $kind === 'receipt' ? 'receipts' : 'payments'; }

/** Editable fields of a cash item from a request body. */
function cf_patch(array $it, array $b): array {
  foreach (['label', 'cadence', 'date', 'until', 'category', 'client', 'note'] as $k) {
    if (array_key_exists($k, $b)) $it[$k] = (string) $b[$k];
  }
  if (array_key_exists('amount', $b)) $it['amount'] = money_num($b['amount']);
  return $it;
}

switch ($action) {
  case 'settings': {
    if (array_key_exists('totalCash', $b)) $store['settings']['totalCash'] = money_num($b['totalCash']);
    if (array_key_exists('vatSetAside', $b)) $store['settings']['vatSetAside'] = abs(money_num($b['vatSetAside']));
    // An empty totalCash clears the override → fall back to balance-sheet cash.
    if (($b['totalCash'] ?? null) === '') unset($store['settings']['totalCash']);
    store_write('cashflow', $store);
    respond(['ok' => true] + cashflow_compute());
  }
  case 'add': {
    $list = cf_list((string) ($b['kind'] ?? 'payment'));
    $it = cf_patch(['id' => bin2hex(random_bytes(6)), 'cadence' => 'monthly'], $b);
    if (trim((string) ($it['label'] ?? '')) === '') fail('label the ' . ($list === 'receipts' ? 'receipt' : 'payment'));
    $store[$list][] = $it;
    store_write('cashflow', $store);
    respond(['ok' => true] + cashflow_compute());
  }
  case 'update': {
    $list = cf_list((string) ($b['kind'] ?? 'payment'));
    $id = (string) ($b['id'] ?? '');
    foreach ($store[$list] as $i => $it) {
      if (($it['id'] ?? '') === $id) {
        $store[$list][$i] = cf_patch($it, $b);
        store_write('cashflow', $store);
        respond(['ok' => true] + cashflow_compute());
      }
    }
    fail('not found', 404);
  }
  case 'delete': {
    $list = cf_list((string) ($b['kind'] ?? 'payment'));
    $id = (string) ($b['id'] ?? '');
    $before = count($store[$list]);
    $store[$list] = array_values(array_filter($store[$list], fn($it) => ($it['id'] ?? '') !== $id));
    if (count($store[$list]) === $before) fail('not found', 404);
    store_write('cashflow', $store);
    respond(['ok' => true] + cashflow_compute());
  }
}
fail('unknown action');
