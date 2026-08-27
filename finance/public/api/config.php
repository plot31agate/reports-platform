<?php
/* config.php — shared plumbing for the Finance HQ API.

   Finance HQ deploys to /public_html/finance/ on DF's own hosting account,
   behind HTTP Basic Auth (.htaccess), so every endpoint here inherits that
   protection. Data is flat JSON files under ../data (never a database, never
   served directly — same archive pattern as the client portal).

   Money is stored as plain numbers in the base currency (GBP). Formatting to
   "£" happens in the browser; the API only ever moves numbers. */

date_default_timezone_set('Europe/London');
header('Content-Type: application/json');

const BASE_CURRENCY = 'GBP';
const JURISDICTION = 'United Kingdom';

$DATA_DIR = __DIR__ . '/../data';

// cPanel profiles ship mbstring, but degrade to byte functions if it is off
// rather than fatal.
if (!function_exists('mb_strlen')) {
  function mb_strlen($s) { return strlen($s); }
  function mb_substr($s, $a, $b = null) { return $b === null ? substr($s, $a) : substr($s, $a, $b); }
}

function respond($data, int $code = 200): void {
  http_response_code($code);
  echo json_encode($data);
  exit;
}

function fail(string $msg, int $code = 400): void {
  respond(['ok' => false, 'error' => $msg], $code);
}

/* ---- JSON file store (flat files, no DB) ---- */

function store_path(string $name): string {
  global $DATA_DIR;
  if (!preg_match('/^[a-z-]+$/', $name)) fail('bad store name', 500);
  if (!is_dir($DATA_DIR)) mkdir($DATA_DIR, 0755, true);
  return $DATA_DIR . '/' . $name . '.json';
}

function store_read(string $name, $fallback = []) {
  $p = store_path($name);
  if (!is_file($p)) return $fallback;
  $data = json_decode((string) file_get_contents($p), true);
  return is_array($data) ? $data : $fallback;
}

function store_write(string $name, $data): void {
  $p = store_path($name);
  // Unique tmp per writer so two concurrent requests never interleave; the
  // rename swap is atomic either way.
  $tmp = $p . '.' . uniqid('', true) . '.tmp';
  if (file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX) === false) {
    fail('could not write store', 500);
  }
  rename($tmp, $p);
}

/* ---- Request body ---- */

function body_json(): array {
  // The Content-Type gate doubles as CSRF protection: a cross-site form cannot
  // send application/json, and fetch() cannot without a CORS preflight.
  if (!str_contains($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) {
    fail('expected application/json', 415);
  }
  $raw = file_get_contents('php://input');
  // Xero CSV exports carrying a couple of years of monthly columns stay well
  // under this; the outer wall is the server's post_max_size.
  if (strlen($raw) > 12 * 1024 * 1024) fail('payload too large', 413);
  $data = json_decode($raw, true);
  if (!is_array($data)) fail('invalid JSON body');
  return $data;
}

/* ---- Board-report share links ----
   A board report can be handed to a director without a Finance HQ login via a
   read-only link guarded by an HMAC token (the public board.php page verifies
   it). Same trick as the client portal's plan links: the signing secret is
   derived from the Anthropic key in claude-config.php, so there's no extra
   secret to manage AND rotating that key instantly revokes every link ever
   sent. One token per report id; a board token can't open anything else. */

function server_secret(): string {
  static $sec = null;
  if ($sec !== null) return $sec;
  $cfgFile = __DIR__ . '/claude-config.php';
  $cfg = is_file($cfgFile) ? include $cfgFile : null;
  $key = is_array($cfg) ? (string) ($cfg['api_key'] ?? $cfg['auth_token'] ?? '') : '';
  // Derived, never the key itself.
  return $sec = ($key === '' ? '' : hash('sha256', 'df-finance-v1|' . $key));
}

function board_token(string $id): string {
  $sec = server_secret();
  if ($sec === '' || !preg_match('/^[a-f0-9]{6,}$/', $id)) return '';
  return hash_hmac('sha256', 'board|' . $id, $sec);
}

/** Constant-time check that a presented token matches the report id. */
function board_token_ok(string $id, string $token): bool {
  $want = board_token($id);
  return $want !== '' && hash_equals($want, $token);
}

/* ---- Money coercion: parse "£1,234.50", "(1,234)", "1234" -> float ---- */

function money_num($v): float {
  if (is_int($v) || is_float($v)) return (float) $v;
  $s = trim((string) $v);
  if ($s === '') return 0.0;
  $neg = false;
  // Accountancy negatives: (1,234.00)
  if (preg_match('/^\((.*)\)$/', $s, $m)) { $neg = true; $s = $m[1]; }
  if (str_contains($s, '-')) $neg = true;
  $s = preg_replace('/[^0-9.]/', '', $s);
  if ($s === '' || $s === '.') return 0.0;
  $n = (float) $s;
  return $neg ? -$n : $n;
}
