<?php
/* ask.php — interrogate the numbers in plain English.

   POST {question}
     -> { ok, result: { answer, figures:[{label,value}], followups:[...] } }
   The model only ever sees the compact finance brief (model.php), so answers
   are grounded in the imported figures and nothing else. */
require __DIR__ . '/claude.php';
require __DIR__ . '/model.php';

$b = body_json();
$q = trim((string) ($b['question'] ?? ''));
if ($q === '') fail('ask a question');
if (mb_strlen($q) > 500) $q = mb_substr($q, 0, 500);

$brief = finance_brief();
if (str_starts_with($brief, 'No financial data')) {
  respond(['ok' => false, 'error' => 'Import a Xero report first — there is nothing to interrogate yet.']);
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

$user = "Here is Digital Footprints' financial data:\n\n$brief\n\n"
  . "Question: $q\n\n"
  . "Answer using only these figures. If the data can't answer it, say what's missing.";

$out = claude_json(claude_system(), $user, $schema, 1200);
respond(['ok' => true, 'result' => $out]);
