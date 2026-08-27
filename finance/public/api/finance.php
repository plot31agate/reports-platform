<?php
/* finance.php — the financial model the dashboard reads, and manual edits.

   GET  -> the full computed model (periods, KPIs, balance). See model.php.
   POST {action}:
     balance       {asAt, cash, debtors, creditors}  — set/patch the balance
                    snapshot by hand (e.g. today's bank balance) when you have
                    not imported a Xero balance sheet.
     delete-period {key}                              — drop one month.
     reset                                            — wipe everything (used by
                    the Import view's "start over"). */
require __DIR__ . '/model.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  respond(['ok' => true] + finance_model());
}

$b = body_json();
$store = finance_store();
$action = $b['action'] ?? '';

switch ($action) {
  case 'balance': {
    $asAt = (string) ($b['asAt'] ?? date('Y-m-d'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $asAt)) $asAt = date('Y-m-d');
    $store['balance'] = [
      'asAt' => $asAt,
      'cash' => money_num($b['cash'] ?? 0),
      'debtors' => money_num($b['debtors'] ?? 0),
      'creditors' => money_num($b['creditors'] ?? 0),
      'source' => 'manual',
      'importedAt' => time(),
    ];
    $store['updatedAt'] = time();
    store_write('finance', $store);
    respond(['ok' => true, 'balance' => $store['balance']]);
  }

  case 'delete-period': {
    $key = (string) ($b['key'] ?? '');
    if (!isset($store['periods'][$key])) fail('not found', 404);
    unset($store['periods'][$key]);
    $store['updatedAt'] = time();
    store_write('finance', $store);
    respond(['ok' => true]);
  }

  case 'reset': {
    store_write('finance', ['periods' => [], 'balance' => null, 'updatedAt' => time()]);
    respond(['ok' => true]);
  }
}
fail('unknown action');
