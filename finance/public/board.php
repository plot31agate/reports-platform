<?php
/* board.php — the public, read-only board report page.

   The ONE door in Finance HQ that sits outside Basic Auth (see .htaccess), so a
   director can open a report from a link without a login. It is useless without
   a valid HMAC token for the requested report id, and it can only ever READ one
   stored report — it writes nothing and exposes no other data.

   /finance/board.php?id=<id>&t=<token> */
require __DIR__ . '/api/config.php';           // gives us store_read + board_token_ok
header('Content-Type: text/html; charset=utf-8');    // override config's JSON default
header('X-Robots-Tag: noindex, nofollow, noarchive');

$id = (string) ($_GET['id'] ?? '');
$token = (string) ($_GET['t'] ?? '');

function deny(int $code, string $msg): void {
  http_response_code($code);
  echo '<!doctype html><meta charset="utf-8"><title>Not available</title>'
    . '<body style="font:16px system-ui;padding:60px;text-align:center;color:#2b4863">'
    . '<h1 style="color:#173756">' . htmlspecialchars($msg) . '</h1>'
    . '<p>This board-report link is invalid or has expired.</p></body>';
  exit;
}

if (!preg_match('/^[a-f0-9]{8,}$/', $id) || $token === '' || !board_token_ok($id, $token)) {
  deny(403, 'Link not valid');
}

$store = store_read('board', ['reports' => []]);
$report = null;
foreach ($store['reports'] ?? [] as $r) if (($r['id'] ?? '') === $id) { $report = $r; break; }
if (!$report) deny(404, 'Report not found');

$k = $report['kpis'] ?? [];
function gbp($v): string { return $v === null ? '—' : '£' . number_format((float) $v, 0); }
function pctval($d): string {
  if (!is_array($d) || ($d['pct'] ?? null) === null) return '';
  return sprintf('%+.1f%%', $d['pct']);
}
function h($s): string { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
$n = $report['narrative'] ?? [];
$genDate = date('j M Y', (int) ($report['generatedAt'] ?? time()));

/** A KPI card. $delta is 'good'|'bad'|'' for colour. */
function kpi(string $label, string $value, string $sub = '', string $tone = ''): string {
  $subhtml = $sub !== '' ? '<div class="kd ' . $tone . '">' . h($sub) . '</div>' : '';
  return '<div class="kpi"><div class="kv">' . h($value) . '</div><div class="kl">' . h($label) . '</div>' . $subhtml . '</div>';
}

$revTone = (($k['revenueDelta']['abs'] ?? 0) >= 0) ? 'good' : 'bad';
$netTone = (($k['netDelta']['abs'] ?? 0) >= 0) ? 'good' : 'bad';
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title><?= h($report['title'] ?? 'Board Report') ?> · Digital Footprints</title>
<style>
  :root{
    --navy:#173756;--navy900:#0e2740;--cream:#fcf7ea;--white:#fff;--cyan:#01d0da;
    --magenta:#fb0ba8;--yellow:#fff100;--ink:#0e2740;--body:#2b4863;--muted:#4a6076;
    --faint:#8aa0b3;--line:#cdd9e2;--soft:#eef3f7;--pass:#0d8a5f;--fail:#d13438;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--cream);color:var(--body);
    font:16px/1.6 "Plus Jakarta Sans",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:0 22px 80px}
  .top{background:var(--navy);color:#fff;margin:0 -22px 0;padding:34px 22px 30px;
    border-bottom:5px solid transparent;border-image:linear-gradient(90deg,#01d0da,#f472cc,#fb0ba8,#fff100,#ff8b00) 1}
  .top .wm{font-weight:800;letter-spacing:-0.02em;font-size:19px}
  .eyebrow{font-weight:700;text-transform:uppercase;letter-spacing:.12em;font-size:11.5px;color:var(--yellow)}
  .eyebrow::before{content:"/ "}
  h1{font-size:30px;font-weight:800;letter-spacing:-0.03em;margin:14px 0 4px;line-height:1.12}
  .meta{color:#9db3c6;font-size:14px}
  .card{background:#fff;border-radius:18px;box-shadow:0 6px 22px rgba(14,39,64,.10);padding:24px 26px;margin-top:22px}
  h2{color:var(--navy);font-size:16px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;margin:0 0 10px}
  h2 span{color:var(--magenta)}
  p{margin:0 0 10px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:22px}
  @media(max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(14,39,64,.08);padding:14px 16px}
  .kv{font-family:"JetBrains Mono",ui-monospace,monospace;font-weight:500;font-size:26px;color:var(--navy);letter-spacing:-0.02em}
  .kl{color:var(--muted);font-size:12px;font-weight:600;margin-top:5px}
  .kd{font-size:12px;font-weight:700;margin-top:6px}
  .kd.good{color:var(--pass)} .kd.bad{color:var(--fail)}
  ul{margin:6px 0 0;padding-left:20px} li{margin-bottom:7px}
  .note{background:var(--soft);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--muted)}
  .foot{margin-top:26px;color:var(--faint);font-size:12.5px;text-align:center}
  @media print{body{background:#fff}.card{box-shadow:none;border:1px solid var(--line)}.top{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="top">
  <div class="wrap" style="padding-bottom:0">
    <div class="wm">Digital Footprints</div>
    <div class="eyebrow" style="margin-top:10px">Board Report</div>
    <h1><?= h($report['title'] ?? ('Board Report — ' . ($report['periodLabel'] ?? ''))) ?></h1>
    <div class="meta"><?= h($report['periodLabel'] ?? '') ?> · generated <?= h($genDate) ?></div>
  </div>
</div>
<div class="wrap">
  <div class="kpis">
    <?= kpi('Revenue', gbp($k['revenue'] ?? null), pctval($k['revenueDelta'] ?? null) ? pctval($k['revenueDelta']) . ' MoM' : '', $revTone) ?>
    <?= kpi('Gross profit', gbp($k['grossProfit'] ?? null), $k['grossMargin'] !== null ? round($k['grossMargin']) . '% margin' : '') ?>
    <?= kpi('Net profit', gbp($k['netProfit'] ?? null), pctval($k['netDelta'] ?? null) ? pctval($k['netDelta']) . ' MoM' : '', $netTone) ?>
    <?= kpi('Cash', gbp($k['cash'] ?? null), $k['runwayMonths'] !== null ? '~' . $k['runwayMonths'] . ' mo runway' : ($k['cash'] !== null ? 'cash-positive' : '')) ?>
  </div>

  <div class="card">
    <h2><span>/</span> Executive summary</h2>
    <p><?= nl2br(h($n['summary'] ?? '')) ?></p>
  </div>

  <div class="card">
    <h2><span>/</span> Performance</h2>
    <p><?= nl2br(h($n['performance'] ?? '')) ?></p>
    <h2 style="margin-top:18px"><span>/</span> Costs &amp; efficiency</h2>
    <p><?= nl2br(h($n['costs'] ?? '')) ?></p>
    <h2 style="margin-top:18px"><span>/</span> Cash position</h2>
    <p><?= nl2br(h($n['cashPosition'] ?? '')) ?></p>
  </div>

  <div class="card">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div>
        <h2><span>/</span> Risks &amp; watch items</h2>
        <ul><?php foreach (($n['risks'] ?? []) as $x) echo '<li>' . h($x) . '</li>'; ?></ul>
      </div>
      <div>
        <h2><span>/</span> Recommendations</h2>
        <ul><?php foreach (($n['recommendations'] ?? []) as $x) echo '<li>' . h($x) . '</li>'; ?></ul>
      </div>
    </div>
  </div>

  <div class="card">
    <h2><span>/</span> Outlook</h2>
    <p><?= nl2br(h($n['outlook'] ?? '')) ?></p>
    <div class="note" style="margin-top:14px"><strong>Tax &amp; compliance note.</strong> <?= nl2br(h($n['taxNote'] ?? '')) ?></div>
  </div>

  <div class="foot">Confidential · Digital Footprints · prepared by Finance HQ. Figures from imported accounts; tax figures are estimates to confirm with the accountant.</div>
</div>
</body>
</html>
