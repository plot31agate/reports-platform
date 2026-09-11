<?php
/* ask.php — interrogate the numbers in plain English, as a CONVERSATION.

   Not one-question-and-done: the thread persists server-side, and Dave keeps a
   NOTEBOOK — "where we're at" — of durable facts he's established across
   conversations (the owner can pin their own and delete stale ones). Every
   question is answered with the notebook + the recent thread in context, and
   follow-ups are instructed to build on both, so the questions get sharper as
   the base builds.

   GET -> { ok, thread:[{q,answer,figures,followups,at}], notebook:[{id,text,at,source}] }
   POST {question, label?}   -> { ok, result:{answer,figures,followups,noteworthy}, thread, notebook }
        label: what to show in the thread when the question carries extra
        context (the Overview's Ask Dave sends the full framing but displays
        just the headline question).
   POST {action:'clear'}          — new conversation (the notebook survives)
   POST {action:'note-add', text} — pin a fact yourself
   POST {action:'note-delete', id}

   The model only ever sees the compact finance brief (model.php) + the bank
   digest + raw statement lines, so answers stay grounded in imported figures. */
require __DIR__ . '/claude.php';
require __DIR__ . '/planning.php';   // pulls model.php; adds pipeline + cash context

const ASK_THREAD_CAP = 200;    // stored exchanges
const ASK_HISTORY_TURNS = 8;   // exchanges replayed into the prompt
const ASK_NOTEBOOK_CAP = 40;

function ask_store(): array {
  $s = store_read('ask', []);
  if (!isset($s['thread']) || !is_array($s['thread'])) $s['thread'] = [];
  if (!isset($s['notebook']) || !is_array($s['notebook'])) $s['notebook'] = [];
  return $s;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $s = ask_store();
  respond(['ok' => true, 'thread' => $s['thread'], 'notebook' => $s['notebook']]);
}

$b = body_json();
$s = ask_store();

switch ($b['action'] ?? '') {
  case 'clear': {
    $s['thread'] = [];
    store_write('ask', $s);
    respond(['ok' => true, 'thread' => [], 'notebook' => $s['notebook']]);
  }
  case 'note-add': {
    $text = mb_substr(trim((string) ($b['text'] ?? '')), 0, 300);
    if ($text === '') fail('write the note first');
    $s['notebook'][] = ['id' => bin2hex(random_bytes(5)), 'text' => $text, 'at' => time(), 'source' => 'you'];
    $s['notebook'] = array_slice($s['notebook'], -ASK_NOTEBOOK_CAP);
    store_write('ask', $s);
    respond(['ok' => true, 'notebook' => $s['notebook']]);
  }
  case 'note-delete': {
    $id = (string) ($b['id'] ?? '');
    $before = count($s['notebook']);
    $s['notebook'] = array_values(array_filter($s['notebook'], fn($n) => ($n['id'] ?? '') !== $id));
    if (count($s['notebook']) === $before) fail('not found', 404);
    store_write('ask', $s);
    respond(['ok' => true, 'notebook' => $s['notebook']]);
  }
}

/* ---- A question ---- */
$q = trim((string) ($b['question'] ?? ''));
if ($q === '') fail('ask a question');
if (mb_strlen($q) > 1200) $q = mb_substr($q, 0, 1200);
$label = mb_substr(trim((string) ($b['label'] ?? '')), 0, 200);
if ($label === '') $label = mb_substr($q, 0, 200);

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

/* The standing context: what's been established across conversations. */
$notebookText = '';
if (count($s['notebook']) > 0) {
  $notebookText = "WHERE WE'RE AT — standing context established in earlier conversations "
    . "(treat as ground truth unless the figures contradict it):\n";
  foreach ($s['notebook'] as $n) {
    $notebookText .= '  - [' . date('j M', (int) ($n['at'] ?? 0)) . '] ' . (string) ($n['text'] ?? '') . "\n";
  }
}

/* The conversation so far: the last few exchanges, answers trimmed. */
$historyText = '';
$recent = array_slice($s['thread'], -ASK_HISTORY_TURNS);
if (count($recent) > 0) {
  $historyText = "THE CONVERSATION SO FAR (this thread — build on it, don't repeat it):\n";
  foreach ($recent as $t) {
    $historyText .= 'Owner: ' . (string) ($t['q'] ?? '') . "\n";
    $historyText .= 'Dave: ' . mb_substr((string) ($t['answer'] ?? ''), 0, 700) . "\n";
  }
}

$schema = [
  'type' => 'object',
  'properties' => [
    'answer' => ['type' => 'string', 'description' => 'A clear, plain-English answer grounded only in the figures. 2–5 sentences. Build on the conversation so far — go deeper, never restate ground already covered.'],
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
      'description' => "2–3 SHARP next questions that move this investigation forward given the conversation and the standing context — specific to this business's live issues (name the client, facility or amount), never generic filler like 'what about costs?'.",
      'items' => ['type' => 'string'],
    ],
    'noteworthy' => ['type' => 'string', 'description' => "ONE short durable fact or conclusion from this answer worth carrying into FUTURE conversations (e.g. 'Debt clears Feb 2027 if Funding Circle gets the overpayments'), or an empty string if nothing new. Never repeat what the standing context already says. Most answers have nothing — be strict."],
  ],
  'required' => ['answer', 'figures', 'followups', 'noteworthy'],
  'additionalProperties' => false,
];

$user = "Here is Digital Footprints' financial data:\n\n$brief\n\n" . planning_brief() . "\n\n"
  . ($notebookText !== '' ? $notebookText . "\n" : '')
  . ($historyText !== '' ? $historyText . "\n" : '')
  . "New question: $q\n\n"
  . "Answer using only these figures. If the data can't answer it, say what's missing. "
  . "You can reason about pipeline win/lose scenarios using the opportunities and cash forecast above.";

$out = claude_json(claude_system(), $user, $schema, 1400);

/* File the exchange, and any durable insight into the notebook. */
$s['thread'][] = [
  'q' => $label,
  'answer' => (string) ($out['answer'] ?? ''),
  'figures' => is_array($out['figures'] ?? null) ? $out['figures'] : [],
  'followups' => is_array($out['followups'] ?? null) ? $out['followups'] : [],
  'at' => time(),
];
$s['thread'] = array_slice($s['thread'], -ASK_THREAD_CAP);

$note = mb_substr(trim((string) ($out['noteworthy'] ?? '')), 0, 300);
if (mb_strlen($note) >= 10) {
  $dup = false;
  foreach ($s['notebook'] as $n) {
    $a = mb_strtolower((string) ($n['text'] ?? '')); $c = mb_strtolower($note);
    if ($a === $c || str_contains($a, $c) || str_contains($c, $a)) { $dup = true; break; }
  }
  if (!$dup) {
    $s['notebook'][] = ['id' => bin2hex(random_bytes(5)), 'text' => $note, 'at' => time(), 'source' => 'dave'];
    $s['notebook'] = array_slice($s['notebook'], -ASK_NOTEBOOK_CAP);
  }
}
store_write('ask', $s);

respond(['ok' => true, 'result' => $out, 'thread' => $s['thread'], 'notebook' => $s['notebook']]);
