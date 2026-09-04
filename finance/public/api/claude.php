<?php
/* claude.php — the shared bridge to the Anthropic Messages API.

   Every AI feature in Finance HQ (Ask the data, scenario planning, and the
   board reports/tax work to come) calls claude_json() from here, so there is
   one place that holds the model, the auth, the JSON-schema structured-output
   contract and the error handling.

   The API key lives in claude-config.php (gitignored + deploy-excluded; see
   claude-config.example.php). Without it, callers get {needsKey:true} so the
   UI can prompt for setup instead of failing blind. */

require_once __DIR__ . '/config.php';

const CLAUDE_MODEL = 'claude-opus-4-8';

/** The system preamble every finance prompt shares: who the model is, the
    currency/jurisdiction it must reason in, and the no-nonsense house style. */
function claude_system(string $extra = ''): string {
  $day = (int) date('j');
  $monthPct = (int) round($day / (int) date('t') * 100);
  $base =
    "You are Dave, the finance analyst inside Finance HQ, the internal dashboard "
    . "for Digital Footprints, a UK business. All figures are in GBP (£). Reason "
    . "in UK terms: Corporation Tax, VAT, PAYE, the UK tax year (6 April–5 April). "
    . "Be precise and plain-spoken — you are talking to the business owner, not "
    . "an accountant. Never invent numbers: use only the figures given, and if "
    . "the data cannot answer a question, say so. Round sensibly. When you give "
    . "tax or compliance framing, note it is an estimate to confirm with their "
    . "accountant, not filed advice.\n"
    . "Today is " . date('j F Y') . " — the current month is only ~{$monthPct}% "
    . "complete. Month-to-date figures for it are PARTIAL: never read them as a "
    . "slump or compare them against full months without saying so. Anchor "
    . "month-on-month commentary on the last COMPLETE month.";
  return $extra === '' ? $base : $base . "\n\n" . $extra;
}

/**
 * Call the Messages API with a JSON-schema structured output.
 *
 * @param string $system  system prompt (use claude_system()).
 * @param string $user    the user turn.
 * @param array  $schema  a JSON Schema object the reply must match.
 * @param int    $maxTokens
 * @return array          the decoded, schema-shaped object.
 * Exits via respond()/fail() on any error (including needsKey).
 */
function claude_json(string $system, string $user, array $schema, int $maxTokens = 1500): array {
  $cfgFile = __DIR__ . '/claude-config.php';
  $cfg = is_file($cfgFile) ? include $cfgFile : null;
  if (!is_array($cfg) || (empty($cfg['api_key']) && empty($cfg['auth_token']))) {
    respond(['ok' => false, 'needsKey' => true, 'error' => 'claude-config.php missing on the server']);
  }

  $payload = json_encode([
    'model' => CLAUDE_MODEL,
    'max_tokens' => $maxTokens,
    'system' => $system,
    'output_config' => ['format' => ['type' => 'json_schema', 'schema' => $schema]],
    'messages' => [['role' => 'user', 'content' => $user]],
  ]);

  $headers = ['Content-Type: application/json', 'anthropic-version: 2023-06-01'];
  if (!empty($cfg['api_key'])) {
    $headers[] = 'x-api-key: ' . $cfg['api_key'];
  } else {
    $headers[] = 'Authorization: Bearer ' . $cfg['auth_token'];
    $headers[] = 'anthropic-beta: oauth-2025-04-20';
  }

  $ch = curl_init('https://api.anthropic.com/v1/messages');
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_TIMEOUT => 280,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
  ]);
  $res = curl_exec($ch);
  if ($res === false) {
    $err = curl_error($ch);
    curl_close($ch);
    fail("could not reach the API: $err", 502);
  }
  $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);

  $data = json_decode($res, true);
  if ($status !== 200) {
    $msg = $data['error']['message'] ?? "HTTP $status";
    $type = $data['error']['type'] ?? 'api_error';
    fail("Claude API $type: $msg", 502);
  }
  if (($data['stop_reason'] ?? '') === 'refusal') fail('the model declined this request');
  if (($data['stop_reason'] ?? '') === 'max_tokens') fail('the answer hit the token limit; try a tighter question');

  $text = '';
  foreach ($data['content'] ?? [] as $block) {
    if (($block['type'] ?? '') === 'text') { $text = $block['text']; break; }
  }
  $out = json_decode($text, true);
  if (!is_array($out)) fail('the model returned unparseable output', 502);
  return $out;
}
