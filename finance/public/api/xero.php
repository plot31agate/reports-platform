<?php
/* xero.php — live Xero sync over OAuth 2.0. Read-only: Finance HQ pulls the
   Profit & Loss and Balance Sheet Reports and never writes to Xero.

   Routes:
     GET  ?action=status                 -> {configured, connected, tenantName, lastSync}
     GET  ?action=connect                -> 302 to Xero's consent screen
     GET  ?code=…&state=…  (redirect_uri)-> exchange the code, store tokens, back to app
     POST {action:sync}                  -> refresh if needed, pull P&L + BS, merge model
     POST {action:disconnect}            -> forget the tokens

   Tokens live in the flat store (data/xero.json — behind Basic Auth, gitignored,
   never served). The access token lasts 30 min; the refresh token rotates on
   every use and is good for 60 days of inactivity. */
require_once __DIR__ . '/model.php';   // config + classify + finance_store/put_period
require_once __DIR__ . '/xero-parse.php';

const XERO_AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS = 'https://api.xero.com/connections';
const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_SCOPES = 'openid profile email accounting.reports.read accounting.settings.read offline_access';

function xero_cfg(): ?array {
  $f = __DIR__ . '/xero-config.php';
  $c = is_file($f) ? include $f : null;
  if (!is_array($c) || empty($c['client_id']) || empty($c['client_secret']) || empty($c['redirect_uri'])) return null;
  return $c;
}
function xero_store(): array { return store_read('xero', ['connected' => false]); }

function xero_token_request(array $cfg, array $form): array {
  $ch = curl_init(XERO_TOKEN);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query($form),
    CURLOPT_HTTPHEADER => [
      'Content-Type: application/x-www-form-urlencoded',
      'Authorization: Basic ' . base64_encode($cfg['client_id'] . ':' . $cfg['client_secret']),
    ],
    CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
  ]);
  $res = curl_exec($ch); $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); $err = curl_error($ch);
  curl_close($ch);
  if ($res === false) fail("could not reach Xero: $err", 502);
  return ['status' => $status, 'data' => (array) json_decode($res, true)];
}

function xero_api_get(string $url, string $token, string $tenant): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'Xero-tenant-id: ' . $tenant, 'Accept: application/json'],
    CURLOPT_TIMEOUT => 60, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
  ]);
  $res = curl_exec($ch); $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); $err = curl_error($ch);
  curl_close($ch);
  if ($res === false) fail("could not reach Xero: $err", 502);
  return ['status' => $status, 'data' => (array) json_decode($res, true)];
}

/** Ensure a live access token, refreshing when it's within a minute of expiry.
    On a failed refresh (revoked / 60-day lapse) marks disconnected and fails. */
function xero_valid_token(array &$store, array $cfg): string {
  if (time() < (int) ($store['expiresAt'] ?? 0) - 60) return (string) $store['accessToken'];
  if (empty($store['refreshToken'])) fail('Xero is not connected', 400);
  $r = xero_token_request($cfg, ['grant_type' => 'refresh_token', 'refresh_token' => $store['refreshToken']]);
  if ($r['status'] !== 200 || empty($r['data']['access_token'])) {
    $store['connected'] = false; store_write('xero', $store);
    fail('Xero session expired — reconnect to sync again', 401);
  }
  $store['accessToken'] = $r['data']['access_token'];
  $store['refreshToken'] = $r['data']['refresh_token'] ?? $store['refreshToken'];
  $store['expiresAt'] = time() + (int) ($r['data']['expires_in'] ?? 1800);
  store_write('xero', $store);
  return (string) $store['accessToken'];
}

function html_exit(string $body, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: text/html; charset=utf-8');
  echo '<!doctype html><meta charset="utf-8"><title>Xero</title>'
    . '<body style="font:16px system-ui;padding:60px;text-align:center;color:#2b4863">' . $body . '</body>';
  exit;
}

/* The sync itself, factored out so the web POST route AND the CLI cron script
   (cron-sync.php) run identical code — a manual pull and an automatic one
   produce the same months. Assumes $cfg is valid and the store is connected
   (the caller checks). Refreshes the token, pulls P&L + Balance Sheet, merges
   them into the finance model, stamps lastSync, and returns an import summary.
   Exits via fail() on a Xero/token error. */
function xero_run_sync(array &$store, array $cfg): array {
  $token = xero_valid_token($store, $cfg);
  $tenant = (string) ($store['tenantId'] ?? '');

  // Profit & Loss: 12 monthly columns (current + 11 prior).
  $pl = xero_api_get(XERO_API . '/Reports/ProfitAndLoss?' . http_build_query(['periods' => 11, 'timeframe' => 'MONTH']), $token, $tenant);
  if ($pl['status'] !== 200) fail('Xero P&L request failed (HTTP ' . $pl['status'] . ')', 502);
  $report = $pl['data']['Reports'][0] ?? null;
  if (!$report) fail('Xero returned no P&L report', 502);

  $fin = finance_store();
  $acc = xero_parse_pl($report);
  $imported = [];
  foreach ($acc as $pk => $buckets) {
    $period = finance_put_period($fin, $pk, $buckets, 'xero-api');
    if ($period === null) continue;
    $t = period_totals($period);
    $imported[] = ['key' => $pk, 'label' => $period['label'], 'income' => $t['income'], 'netProfit' => $t['netProfit']];
  }
  usort($imported, fn($a, $c) => strcmp($a['key'], $c['key']));

  // Balance Sheet (as at today).
  $balSummary = null;
  $bs = xero_api_get(XERO_API . '/Reports/BalanceSheet', $token, $tenant);
  if ($bs['status'] === 200 && !empty($bs['data']['Reports'][0])) {
    $b2 = xero_parse_bs($bs['data']['Reports'][0]);
    $fin['balance'] = $b2 + ['source' => 'xero-api', 'importedAt' => time()];
    $balSummary = $b2;
  }

  $fin['updatedAt'] = time();
  store_write('finance', $fin);

  $store['lastSync'] = time();
  $store['lastSyncSummary'] = ['months' => count($imported), 'at' => time()];
  store_write('xero', $store);

  return ['periods' => $imported, 'accounts' => count($imported), 'balance' => $balSummary];
}

// Everything below is HTTP request routing. The CLI cron (cron-sync.php) only
// needs the functions above, so stop here when included from the command line.
if (PHP_SAPI === 'cli') return;

/* ============================================================
   OAuth callback: Xero redirects here with ?code&state
   ============================================================ */
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['code'])) {
  $cfg = xero_cfg();
  if (!$cfg) html_exit('<h1>Xero isn’t configured</h1><p>Add api/xero-config.php on the server.</p>', 500);
  $store = xero_store();
  // CSRF: the state we sent must come back.
  if (!isset($_GET['state']) || !hash_equals((string) ($store['state'] ?? ''), (string) $_GET['state'])) {
    html_exit('<h1>Couldn’t verify that sign-in</h1><p>Please try connecting again.</p>', 400);
  }
  $r = xero_token_request($cfg, [
    'grant_type' => 'authorization_code',
    'code' => (string) $_GET['code'],
    'redirect_uri' => $cfg['redirect_uri'],
  ]);
  if ($r['status'] !== 200 || empty($r['data']['access_token'])) {
    html_exit('<h1>Xero sign-in failed</h1><p>' . htmlspecialchars($r['data']['error'] ?? 'Please try again.') . '</p>', 502);
  }
  $access = $r['data']['access_token'];
  $store['accessToken'] = $access;
  $store['refreshToken'] = $r['data']['refresh_token'] ?? '';
  $store['expiresAt'] = time() + (int) ($r['data']['expires_in'] ?? 1800);

  // Which organisation? Pick the first accounting tenant.
  $c = xero_api_get(XERO_CONNECTIONS, $access, '');
  $tenant = null;
  foreach ($c['data'] as $conn) {
    if (($conn['tenantType'] ?? '') === 'ORGANISATION') { $tenant = $conn; break; }
  }
  $tenant = $tenant ?? ($c['data'][0] ?? null);
  if (!$tenant) html_exit('<h1>No Xero organisation found</h1><p>Grant access to an organisation and try again.</p>', 502);
  $store['tenantId'] = $tenant['tenantId'] ?? '';
  $store['tenantName'] = $tenant['tenantName'] ?? 'Xero';
  $store['connected'] = true;
  unset($store['state']);
  store_write('xero', $store);

  header('Location: ../#import');   // /finance/api/xero.php -> /finance/#import
  http_response_code(302);
  exit;
}

/* ============================================================
   GET actions: status, connect
   ============================================================ */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $action = $_GET['action'] ?? 'status';
  $cfg = xero_cfg();
  $store = xero_store();

  if ($action === 'status') {
    respond([
      'ok' => true,
      'configured' => $cfg !== null,
      'connected' => (bool) ($store['connected'] ?? false),
      'tenantName' => $store['tenantName'] ?? null,
      'lastSync' => (int) ($store['lastSync'] ?? 0),
      'lastSyncSummary' => $store['lastSyncSummary'] ?? null,
    ]);
  }

  if ($action === 'connect') {
    if (!$cfg) fail('Xero is not configured on the server (api/xero-config.php).', 400);
    $state = bin2hex(random_bytes(16));
    $store['state'] = $state;
    store_write('xero', $store);
    // RFC3986 encoding: the scope separators must be %20, not the default '+'.
    // Xero's authorize endpoint rejects '+'-joined scopes as invalid_scope.
    $url = XERO_AUTHORIZE . '?' . http_build_query([
      'response_type' => 'code',
      'client_id' => $cfg['client_id'],
      'redirect_uri' => $cfg['redirect_uri'],
      'scope' => XERO_SCOPES,
      'state' => $state,
    ], '', '&', PHP_QUERY_RFC3986);
    header('Location: ' . $url);
    http_response_code(302);
    exit;
  }
  fail('unknown action');
}

/* ============================================================
   POST actions: sync, disconnect
   ============================================================ */
$b = body_json();
$action = $b['action'] ?? '';
$cfg = xero_cfg();
$store = xero_store();

if ($action === 'disconnect') {
  store_write('xero', ['connected' => false]);
  respond(['ok' => true]);
}

if ($action !== 'sync') fail('unknown action');
if (!$cfg) fail('Xero is not configured on the server.', 400);
if (empty($store['connected'])) fail('Xero is not connected — connect first.', 400);

$summary = xero_run_sync($store, $cfg);
respond(['ok' => true, 'tenantName' => $store['tenantName'] ?? 'Xero', 'summary' => $summary]);
