<?php
/* retainers.php — the RETAINER BOOK: the agreed, ongoing monthly retainers.

   This is where a signed retainer lives — not the Pipeline (that's for work
   you might still win). The book is the "should be coming in" list; the bank
   rhythm (Money in) is the "is coming in" list. The two reconcile by name:
   a book entry already paying through the bank is tracked from the bank
   rhythm and never counted twice, and one the bank hasn't seen yet feeds the
   13-week cash-flow floor from its start date (planning.php).

   GET -> { ok, retainers:[{id,client,monthly,startDate,status,note,createdAt}] }
   POST {action}:
     add    {client, monthly, startDate?, note?}
     update {id, …any of client/monthly/startDate/status/note}
     delete {id}
   status: active | paused | ended (only active feeds the forecast). */
require __DIR__ . '/planning.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  respond(['ok' => true, 'retainers' => retainer_book()]);
}

$b = body_json();
$store = store_read('retainers', ['items' => []]);
if (!isset($store['items']) || !is_array($store['items'])) $store['items'] = [];

/** Pull the editable fields out of a request body onto a book entry. */
function retainer_patch(array $r, array $b): array {
  if (array_key_exists('client', $b)) $r['client'] = mb_substr(trim((string) $b['client']), 0, 120);
  if (array_key_exists('monthly', $b)) $r['monthly'] = max(0, money_num($b['monthly']));
  if (array_key_exists('startDate', $b)) {
    $d = (string) $b['startDate'];
    $r['startDate'] = preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) ? $d : '';
  }
  if (array_key_exists('status', $b)) {
    $s = (string) $b['status'];
    $r['status'] = in_array($s, ['active', 'paused', 'ended'], true) ? $s : 'active';
  }
  if (array_key_exists('note', $b)) $r['note'] = mb_substr(trim((string) $b['note']), 0, 300);
  return $r;
}

switch ($b['action'] ?? '') {
  case 'add': {
    $r = retainer_patch(['id' => bin2hex(random_bytes(6)), 'status' => 'active', 'createdAt' => time()], $b);
    if (trim((string) ($r['client'] ?? '')) === '') fail('name the client');
    $store['items'][] = $r;
    store_write('retainers', $store);
    respond(['ok' => true, 'retainers' => retainer_book()]);
  }
  case 'update': {
    $id = (string) ($b['id'] ?? '');
    foreach ($store['items'] as $i => $r) {
      if (($r['id'] ?? '') === $id) {
        $store['items'][$i] = retainer_patch($r, $b);
        store_write('retainers', $store);
        respond(['ok' => true, 'retainers' => retainer_book()]);
      }
    }
    fail('not found', 404);
  }
  case 'delete': {
    $id = (string) ($b['id'] ?? '');
    $before = count($store['items']);
    $store['items'] = array_values(array_filter($store['items'], fn($r) => ($r['id'] ?? '') !== $id));
    if (count($store['items']) === $before) fail('not found', 404);
    store_write('retainers', $store);
    respond(['ok' => true, 'retainers' => retainer_book()]);
  }
}
fail('unknown action');
