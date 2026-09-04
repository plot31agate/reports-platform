<?php
/* bank.php — the bank-statement store.

   The browser parses the Starling CSV (lib/bank.ts) and posts plain
   transaction rows; this endpoint only merges, dedupes and stores them.
   All classification and analytics stay client-side so the rules can
   improve without re-importing.

   GET -> { ok, txs:[{date,cp,ref,type,amount,balance,category}], importedAt, digest }
   POST {action}:
     import {txs}    — merge + dedupe; responds with the full merged set
     digest {digest} — store the compact text brief ask.php feeds to Claude
     reset
*/
require __DIR__ . '/config.php';

function bank_store(): array {
  $s = store_read('bank', []);
  if (!isset($s['txs']) || !is_array($s['txs'])) $s['txs'] = [];
  if (!isset($s['digest'])) $s['digest'] = '';
  if (!isset($s['loanMeta']) || !is_array($s['loanMeta'])) $s['loanMeta'] = [];
  return $s;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $s = bank_store();
  respond(['ok' => true, 'txs' => $s['txs'], 'importedAt' => $s['importedAt'] ?? 0,
    'digest' => $s['digest'], 'loanMeta' => (object) $s['loanMeta']]);
}

$b = body_json();
$s = bank_store();

switch ($b['action'] ?? '') {
  case 'import': {
    $incoming = $b['txs'] ?? null;
    if (!is_array($incoming) || count($incoming) === 0) fail('no transactions in payload');
    if (count($incoming) > 50000) fail('too many rows', 413);

    $clean = [];
    foreach ($incoming as $t) {
      if (!is_array($t)) continue;
      $date = (string) ($t['date'] ?? '');
      if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
      $clean[] = [
        'date' => $date,
        'cp' => mb_substr(trim((string) ($t['cp'] ?? '')), 0, 120),
        'ref' => mb_substr(trim((string) ($t['ref'] ?? '')), 0, 120),
        'type' => mb_substr(trim((string) ($t['type'] ?? '')), 0, 40),
        'amount' => (float) ($t['amount'] ?? 0),
        'balance' => (float) ($t['balance'] ?? 0),
        'category' => mb_substr(trim((string) ($t['category'] ?? '')), 0, 60),
      ];
    }
    if (count($clean) === 0) fail('no valid transaction rows');

    // Merge with what's stored. Identical rows CAN legitimately repeat (three
    // £8.49 charges in one day), so the fingerprint carries an occurrence
    // index: an overlapping re-import keeps the max count seen, never doubles.
    $fp = function (array $t): string {
      return $t['date'] . '|' . $t['cp'] . '|' . $t['ref'] . '|'
        . number_format($t['amount'], 2, '.', '') . '|' . number_format($t['balance'], 2, '.', '');
    };
    $index = [];
    $before = count($s['txs']);
    foreach ($s['txs'] as $t) {
      $k = $fp($t);
      $index[$k] = ($index[$k] ?? 0) + 1;
    }
    $seen = [];
    $added = 0;
    foreach ($clean as $t) {
      $k = $fp($t);
      $seen[$k] = ($seen[$k] ?? 0) + 1;
      if ($seen[$k] > ($index[$k] ?? 0)) { $s['txs'][] = $t; $added++; }
    }
    usort($s['txs'], fn($a, $b2) => strcmp($a['date'], $b2['date']));
    $s['importedAt'] = time();
    store_write('bank', $s);
    respond(['ok' => true, 'added' => $added, 'skipped' => count($clean) - $added,
      'total' => count($s['txs']), 'hadBefore' => $before, 'txs' => $s['txs']]);
  }

  case 'digest': {
    $s['digest'] = mb_substr((string) ($b['digest'] ?? ''), 0, 20000);
    store_write('bank', $s);
    respond(['ok' => true]);
  }

  case 'loans': {
    // Owner-entered facts the statement can't know: balance and rate per
    // facility, keyed by the registry's entity name.
    $meta = $b['loanMeta'] ?? null;
    if (!is_array($meta)) fail('loanMeta must be an object');
    $clean = [];
    foreach ($meta as $entity => $m) {
      if (!is_array($m)) continue;
      $clean[mb_substr((string) $entity, 0, 120)] = [
        'balance' => max(0, (float) ($m['balance'] ?? 0)),
        'apr' => max(0, min(200, (float) ($m['apr'] ?? 0))),
        'note' => mb_substr(trim((string) ($m['note'] ?? '')), 0, 300),
      ];
    }
    $s['loanMeta'] = $clean;
    store_write('bank', $s);
    respond(['ok' => true, 'loanMeta' => $clean]);
  }

  case 'reset': {
    store_write('bank', ['txs' => [], 'digest' => '', 'importedAt' => 0]);
    respond(['ok' => true]);
  }
}
fail('unknown action');
