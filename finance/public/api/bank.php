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
  if (!isset($s['spaces']) || !is_array($s['spaces'])) $s['spaces'] = [];
  if (!isset($s['events']) || !is_array($s['events'])) $s['events'] = [];
  if (!isset($s['answers']) || !is_array($s['answers'])) $s['answers'] = [];
  return $s;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $s = bank_store();
  respond(['ok' => true, 'txs' => $s['txs'], 'importedAt' => $s['importedAt'] ?? 0,
    'digest' => $s['digest'], 'loanMeta' => (object) $s['loanMeta'],
    'spaces' => $s['spaces'], 'events' => $s['events'], 'answers' => (object) $s['answers']]);
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

  case 'spaces': {
    // Starling Spaces don't export statements, so ring-fenced money (the VAT
    // pot) is invisible to the imported statement. These are owner-entered:
    // name, what the money is for, and the balance today.
    $spaces = $b['spaces'] ?? null;
    if (!is_array($spaces)) fail('spaces must be a list');
    $clean = [];
    foreach (array_slice($spaces, 0, 30) as $sp) {
      if (!is_array($sp)) continue;
      $name = mb_substr(trim((string) ($sp['name'] ?? '')), 0, 80);
      if ($name === '') continue;
      $kind = (string) ($sp['kind'] ?? 'other');
      $clean[] = [
        'name' => $name,
        'kind' => in_array($kind, ['vat', 'tax', 'savings', 'other'], true) ? $kind : 'other',
        'balance' => max(0, (float) ($sp['balance'] ?? 0)),
      ];
    }
    $s['spaces'] = $clean;
    $s['spacesUpdatedAt'] = time();
    store_write('bank', $s);
    respond(['ok' => true, 'spaces' => $clean]);
  }

  case 'events': {
    // Conference / event activity: planned spend with line items and an
    // optional client contribution. Replaces the whole list on each save.
    $events = $b['events'] ?? null;
    if (!is_array($events)) fail('events must be a list');
    $clean = [];
    foreach (array_slice($events, 0, 50) as $e) {
      if (!is_array($e)) continue;
      $name = mb_substr(trim((string) ($e['name'] ?? '')), 0, 120);
      if ($name === '') continue;
      $items = [];
      foreach (array_slice(is_array($e['items'] ?? null) ? $e['items'] : [], 0, 30) as $it) {
        if (!is_array($it)) continue;
        $lbl = mb_substr(trim((string) ($it['label'] ?? '')), 0, 80);
        if ($lbl === '') continue;
        $items[] = ['label' => $lbl, 'amount' => max(0, (float) ($it['amount'] ?? 0))];
      }
      $dateOk = fn($v) => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $v) ? (string) $v : '';
      $clean[] = [
        'id' => preg_match('/^[a-f0-9]{6,}$/', (string) ($e['id'] ?? '')) ? (string) $e['id'] : bin2hex(random_bytes(6)),
        'name' => $name,
        'location' => mb_substr(trim((string) ($e['location'] ?? '')), 0, 80),
        'start' => $dateOk($e['start'] ?? ''),
        'end' => $dateOk($e['end'] ?? ''),
        'client' => mb_substr(trim((string) ($e['client'] ?? '')), 0, 80),
        'clientContribution' => max(0, (float) ($e['clientContribution'] ?? 0)),
        'items' => $items,
      ];
    }
    $s['events'] = $clean;
    store_write('bank', $s);
    respond(['ok' => true, 'events' => $clean]);
  }

  case 'answer': {
    // File (or clear) the owner's answer to a raised question. The key is the
    // question's stable id from lib/bank.ts, so the decision survives
    // recomputes and feeds the Ask digest as ground truth.
    $key = mb_substr(trim((string) ($b['key'] ?? '')), 0, 160);
    if ($key === '') fail('key required');
    $answer = mb_substr(trim((string) ($b['answer'] ?? '')), 0, 2000);
    if ($answer === '') {
      unset($s['answers'][$key]);
    } else {
      $s['answers'][$key] = [
        'question' => mb_substr(trim((string) ($b['question'] ?? '')), 0, 400),
        'answer' => $answer,
        'savedAt' => time(),
      ];
    }
    store_write('bank', $s);
    respond(['ok' => true, 'answers' => (object) $s['answers']]);
  }

  case 'reset': {
    store_write('bank', ['txs' => [], 'digest' => '', 'importedAt' => 0]);
    respond(['ok' => true]);
  }
}
fail('unknown action');
