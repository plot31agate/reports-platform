<?php
/* ask.php — interrogate the numbers in plain English.

   POST {question}
     -> { ok, result: { answer, figures:[{label,value}], followups:[...] } }
   The model only ever sees the compact finance brief (model.php), so answers
   are grounded in the imported figures and nothing else. */
require __DIR__ . '/claude.php';
require __DIR__ . '/planning.php';   // pulls model.php; adds pipeline + cash context

$b = body_json();
$q = trim((string) ($b['question'] ?? ''));
if ($q === '') fail('ask a question');
if (mb_strlen($q) > 500) $q = mb_substr($q, 0, 500);

$brief = finance_brief();
$bank = store_read('bank', []);
$bankDigest = trim((string) ($bank['digest'] ?? ''));
if (str_starts_with($brief, 'No financial data') && $bankDigest === '') {
  respond(['ok' => false, 'error' => 'Import a Xero report or a bank statement first — there is nothing to interrogate yet.']);
}
if ($bankDigest !== '') $brief .= "\n\n" . $bankDigest;

/* The digest is only a summary; drill-down questions ("what did we spend on
   travel and where?") need the actual statement lines. Ship them compactly —
   date|counterparty|reference|amount|category, most recent 2000 rows — so
   Claude can name the payees behind any figure, not just the totals. */
$bankTxs = is_array($bank['txs'] ?? null) ? $bank['txs'] : [];
if (count($bankTxs) > 0) {
  $rows = array_slice($bankTxs, -2000);
  $lines = [];
  foreach ($rows as $t) {
    $ref = trim((string) ($t['ref'] ?? ''));
    $lines[] = ($t['date'] ?? '') . '|' . ($t['cp'] ?? '') . '|' . mb_substr($ref, 0, 24) . '|'
      . number_format((float) ($t['amount'] ?? 0), 2, '.', '') . '|' . ($t['category'] ?? '');
  }
  $brief .= "\n\nRAW BANK TRANSACTIONS (date|counterparty|reference|amount GBP, negative = money out|Starling category). "
    . "Use these for any drill-down — who, where, when — applying the counterparty notes above (e.g. Lemino = Vivo):\n"
    . implode("\n", $lines);
}

$schema = [
  'type' => 'object',
  'properties' => [
    'answer' => ['type' => 'string', 'description' => 'A clear, plain-English answer grounded only in the figures. 2–5 sentences.'],
    'figures' => [
      'type' => 'array',
      'description' => 'The key numbers behind the answer, if any. Values as strings, formatted with £ and commas.',
      'items' => [
        'type' => 'object',
        'properties' => ['label' => ['type' => 'string'], 'value' => ['type' => 'string']],
        'required' => ['label', 'value'],
        'additionalProperties' => false,
      ],
    ],
    'followups' => [
      'type' => 'array',
      'description' => '2–3 natural follow-up questions the owner might ask next.',
      'items' => ['type' => 'string'],
    ],
  ],
  'required' => ['answer', 'figures', 'followups'],
  'additionalProperties' => false,
];

$user = "Here is Digital Footprints' financial data:\n\n$brief\n\n" . planning_brief() . "\n\n"
  . "Question: $q\n\n"
  . "Answer using only these figures. If the data can't answer it, say what's missing. "
  . "You can reason about pipeline win/lose scenarios using the opportunities and cash forecast above.";

$out = claude_json(claude_system(), $user, $schema, 1200);
respond(['ok' => true, 'result' => $out]);
