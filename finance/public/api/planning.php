<?php
/* planning.php — the shared engine behind the two planning surfaces:

     Pipeline   (pipeline.php)  — agreed vs potential work, weighted by stage.
     Cash flow  (cashflow.php)  — a 13-week rolling forecast of the bank.

   The maths lives here once so the two route handlers, the AI brief (ask.php /
   forecast.php) and the cron all read the same numbers — the same pattern as
   model.php for the P&L. Pure functions over the `pipeline` and `cashflow`
   flat stores; no output. Requires model.php (finance_model, money_num). */
require_once __DIR__ . '/model.php';

/* Stage → default win probability (%). Manual override wins when set. */
const STAGE_PROB = [
  'lead' => 10, 'qualified' => 25, 'proposal' => 50, 'verbal' => 80, 'won' => 100, 'lost' => 0,
];
const STAGE_ORDER = ['lead', 'qualified', 'proposal', 'verbal', 'won', 'lost'];
const CASH_WEEKS = 13;

/* ============================================================
   Pipeline
   ============================================================ */

function pipeline_store(): array {
  $s = store_read('pipeline', ['opps' => []]);
  if (!isset($s['opps']) || !is_array($s['opps'])) $s['opps'] = [];
  return $s;
}

/** Effective win probability for one opportunity: manual override, else the
    stage default. Clamped 0–100. */
function opp_probability(array $o): int {
  $p = $o['probability'] ?? null;
  if ($p !== null && $p !== '') return max(0, min(100, (int) $p));
  return STAGE_PROB[$o['stage'] ?? 'lead'] ?? 0;
}

/** One opportunity, normalised with its computed fields for the UI + forecast. */
function opp_view(array $o): array {
  $type = ($o['type'] ?? 'retainer') === 'project' ? 'project' : 'retainer';
  $value = round((float) money_num($o['value'] ?? 0), 2);
  $prob = opp_probability($o);
  return [
    'id' => (string) ($o['id'] ?? ''),
    'client' => (string) ($o['client'] ?? ''),
    'type' => $type,
    'value' => $value,                        // retainer = £/month, project = £ one-off
    'stage' => in_array($o['stage'] ?? '', STAGE_ORDER, true) ? $o['stage'] : 'lead',
    'probability' => $prob,
    'probabilityAuto' => !isset($o['probability']) || $o['probability'] === null || $o['probability'] === '',
    'startDate' => (string) ($o['startDate'] ?? ''),
    'decisionDate' => (string) ($o['decisionDate'] ?? ''),
    'nextAction' => (string) ($o['nextAction'] ?? ''),
    'includeInForecast' => (bool) ($o['includeInForecast'] ?? false),
    'weighted' => round($value * $prob / 100, 2),  // per-month for retainers, one-off for projects
    'createdAt' => (int) ($o['createdAt'] ?? 0),
  ];
}

/** Annualised worth of one opportunity — retainer×12 + project one-off — so a
    monthly retainer and a one-off project can be compared / concentrated. */
function opp_annual_value(array $v): float {
  return $v['type'] === 'retainer' ? $v['value'] * 12 : $v['value'];
}

/** The full pipeline view: every opp (computed) plus the headline roll-ups. */
function pipeline_compute(): array {
  $opps = array_map('opp_view', pipeline_store()['opps']);
  usort($opps, fn($a, $b) => array_search($a['stage'], STAGE_ORDER) <=> array_search($b['stage'], STAGE_ORDER)
    ?: $b['weighted'] <=> $a['weighted']);

  $committedMrr = 0.0; $committedProject = 0.0;
  $weightedMrr = 0.0; $weightedProject = 0.0;
  $open = 0; $byStage = array_fill_keys(STAGE_ORDER, 0);
  $clientBook = [];  // annualised committed value per client → concentration

  foreach ($opps as $v) {
    $byStage[$v['stage']]++;
    if ($v['stage'] === 'won') {
      if ($v['type'] === 'retainer') $committedMrr += $v['value']; else $committedProject += $v['value'];
      $clientBook[$v['client']] = ($clientBook[$v['client']] ?? 0) + opp_annual_value($v);
    } elseif ($v['stage'] !== 'lost') {
      $open++;
      if ($v['type'] === 'retainer') $weightedMrr += $v['weighted']; else $weightedProject += $v['weighted'];
    }
  }

  $bookTotal = array_sum($clientBook);
  $topClient = null; $topShare = null;
  if ($bookTotal > 0) {
    arsort($clientBook);
    $topClient = array_key_first($clientBook);
    $topShare = round(reset($clientBook) / $bookTotal * 100, 1);
  }

  return [
    'opps' => $opps,
    'summary' => [
      'mrr' => round($committedMrr, 2),                     // agreed recurring, £/mo
      'committedMrr' => round($committedMrr, 2),
      'committedProject' => round($committedProject, 2),
      'committedAnnual' => round($committedMrr * 12 + $committedProject, 2),
      'weightedMrr' => round($weightedMrr, 2),              // potential recurring, weighted £/mo
      'weightedProject' => round($weightedProject, 2),      // potential one-off, weighted £
      'openCount' => $open,
      'wonCount' => $byStage['won'],
      'byStage' => $byStage,
      'topClient' => $topClient,
      'topClientShare' => $topShare,                        // % of committed book (annualised)
    ],
  ];
}

/* ============================================================
   Cash flow — 13-week rolling forecast
   ============================================================ */

function cashflow_store(): array {
  $s = store_read('cashflow', []);
  foreach (['payments', 'receipts'] as $k) if (!isset($s[$k]) || !is_array($s[$k])) $s[$k] = [];
  if (!isset($s['settings']) || !is_array($s['settings'])) $s['settings'] = [];
  return $s;
}

/** Monday 00:00 of the week containing $d. */
function week_monday(DateTimeImmutable $d): DateTimeImmutable {
  $dow = (int) $d->format('N');           // 1 (Mon) … 7 (Sun)
  return $d->modify('-' . ($dow - 1) . ' days')->setTime(0, 0, 0);
}

/** Expand a recurring item into the concrete due-dates that fall in the window. */
function plan_occurrences(string $cadence, string $anchor, string $until, DateTimeImmutable $winStart, DateTimeImmutable $winEnd): array {
  if (trim($anchor) === '') $anchor = $winStart->format('Y-m-d');
  try { $d = new DateTimeImmutable($anchor); } catch (Exception $e) { return []; }
  $d = $d->setTime(0, 0, 0);
  $untilD = null;
  if (trim($until) !== '') { try { $untilD = (new DateTimeImmutable($until))->setTime(0, 0, 0); } catch (Exception $e) {} }

  $stepMap = ['weekly' => 'P7D', 'fortnightly' => 'P14D', '4weekly' => 'P28D', 'monthly' => 'P1M', 'quarterly' => 'P3M'];
  if (!isset($stepMap[$cadence])) {  // 'once'
    return ($d >= $winStart && $d <= $winEnd && ($untilD === null || $d <= $untilD)) ? [$d->format('Y-m-d')] : [];
  }
  $interval = new DateInterval($stepMap[$cadence]);
  $out = []; $guard = 0;
  while ($d < $winStart && $guard++ < 800) $d = $d->add($interval);
  while ($d <= $winEnd && $guard++ < 800) {
    if ($untilD !== null && $d > $untilD) break;
    $out[] = $d->format('Y-m-d');
    $d = $d->add($interval);
  }
  return $out;
}

/** Which 0-based week does a Y-m-d land in, or -1 if outside the window. */
function week_index(string $ymd, DateTimeImmutable $winStart): int {
  try { $d = (new DateTimeImmutable($ymd))->setTime(0, 0, 0); } catch (Exception $e) { return -1; }
  $days = (int) floor(($d->getTimestamp() - $winStart->getTimestamp()) / 86400);
  $wk = intdiv($days, 7);
  return ($wk >= 0 && $wk < CASH_WEEKS) ? $wk : -1;
}

/**
 * Build the 13-week forecast.
 *  - Committed line (floor): manual receipts + WON pipeline in, manual payments out.
 *  - Scenario line: committed + any open opp flagged includeInForecast, at full value.
 * @return array{weeks:array,headline:array,included:array}
 */
function cashflow_compute(): array {
  $store = cashflow_store();
  $model = finance_model();
  $pipe = pipeline_compute();

  $winStart = week_monday(new DateTimeImmutable('today'));
  $winEnd = $winStart->modify('+' . (CASH_WEEKS * 7 - 1) . ' days')->setTime(23, 59, 59);

  // Opening bank: explicit setting, else the imported balance-sheet cash.
  $settings = $store['settings'];
  $balCash = (float) ($model['balance']['cash'] ?? 0);
  $totalCash = array_key_exists('totalCash', $settings) ? (float) $settings['totalCash'] : $balCash;
  $vat = (float) ($settings['vatSetAside'] ?? 0);

  // Empty per-week accumulators.
  $recCommitted = array_fill(0, CASH_WEEKS, 0.0);
  $recScenario = array_fill(0, CASH_WEEKS, 0.0);
  $pay = array_fill(0, CASH_WEEKS, 0.0);

  $addOcc = function (array &$bucket, string $cadence, string $anchor, string $until, float $amount) use ($winStart, $winEnd) {
    foreach (plan_occurrences($cadence, $anchor, $until, $winStart, $winEnd) as $ymd) {
      $wk = week_index($ymd, $winStart);
      if ($wk >= 0) $bucket[$wk] += $amount;
    }
  };

  // Manual receipts (both lines) and manual payments.
  foreach ($store['receipts'] as $r) {
    $amt = (float) money_num($r['amount'] ?? 0);
    if ($amt <= 0) continue;
    $addOcc($recCommitted, $r['cadence'] ?? 'once', $r['date'] ?? '', $r['until'] ?? '', $amt);
    $addOcc($recScenario, $r['cadence'] ?? 'once', $r['date'] ?? '', $r['until'] ?? '', $amt);
  }
  foreach ($store['payments'] as $p) {
    $amt = abs((float) money_num($p['amount'] ?? 0));
    if ($amt <= 0) continue;
    $addOcc($pay, $p['cadence'] ?? 'once', $p['date'] ?? '', $p['until'] ?? '', $amt);
  }

  // Pipeline: WON → both lines; open+flagged → scenario only. A retainer bills
  // monthly from its start date; a project lands once on its start date.
  $included = [];
  foreach ($pipe['opps'] as $o) {
    if ($o['value'] <= 0) continue;
    $inFloor = $o['stage'] === 'won';
    $inScenario = $inFloor || ($o['includeInForecast'] && $o['stage'] !== 'lost');
    if (!$inFloor && !$inScenario) continue;
    $cadence = $o['type'] === 'retainer' ? 'monthly' : 'once';
    if ($inFloor) $addOcc($recCommitted, $cadence, $o['startDate'], '', $o['value']);
    if ($inScenario) {
      $addOcc($recScenario, $cadence, $o['startDate'], '', $o['value']);
      if (!$inFloor) $included[] = ['id' => $o['id'], 'client' => $o['client'], 'value' => $o['value'], 'type' => $o['type']];
    }
  }

  // Roll the running balances forward.
  $weeks = [];
  $openC = $totalCash; $openS = $totalCash;
  $firstNegative = null;
  for ($i = 0; $i < CASH_WEEKS; $i++) {
    $ws = $winStart->modify('+' . ($i * 7) . ' days');
    $closeC = $openC + $recCommitted[$i] - $pay[$i];
    $closeS = $openS + $recScenario[$i] - $pay[$i];
    if ($firstNegative === null && $closeC < 0) $firstNegative = $i + 1;
    $weeks[] = [
      'index' => $i,
      'weekStart' => $ws->format('Y-m-d'),
      'label' => $ws->format('j M'),
      'openingCommitted' => round($openC, 2),
      'receipts' => round($recCommitted[$i], 2),
      'payments' => round($pay[$i], 2),
      'closingCommitted' => round($closeC, 2),
      'receiptsScenario' => round($recScenario[$i], 2),
      'closingScenario' => round($closeS, 2),
    ];
    $openC = $closeC; $openS = $closeS;
  }

  // Runway in weeks: weeks until the committed balance first goes negative.
  $totalNet = ($openC - $totalCash); // committed net over the whole window
  $runwayWeeks = null; $runwayNote = '';
  if ($firstNegative !== null) { $runwayWeeks = $firstNegative; $runwayNote = 'weeks until cash runs out'; }
  elseif ($totalNet >= 0) { $runwayNote = 'cash-positive over the next 13 weeks'; }
  else { $runwayNote = 'more than 13 weeks of cover'; }

  return [
    'weeks' => $weeks,
    'settings' => ['totalCash' => round($totalCash, 2), 'vatSetAside' => round($vat, 2), 'usingBalanceCash' => !array_key_exists('totalCash', $settings)],
    'headline' => [
      'totalCash' => round($totalCash, 2),
      'vatSetAside' => round($vat, 2),
      'availableCash' => round($totalCash - $vat, 2),   // Available = total − ring-fenced VAT
      'runwayWeeks' => $runwayWeeks,
      'runwayNote' => $runwayNote,
      'endCommitted' => round($weeks[CASH_WEEKS - 1]['closingCommitted'], 2),
      'endScenario' => round($weeks[CASH_WEEKS - 1]['closingScenario'], 2),
    ],
    'payments' => array_map('cashflow_item_view', $store['payments']),
    'receipts' => array_map('cashflow_item_view', $store['receipts']),
    'included' => $included,
  ];
}

/** Normalise a stored payment/receipt for the UI. */
function cashflow_item_view(array $it): array {
  $cadences = ['once', 'weekly', 'fortnightly', '4weekly', 'monthly', 'quarterly'];
  return [
    'id' => (string) ($it['id'] ?? ''),
    'label' => (string) ($it['label'] ?? ''),
    'category' => (string) ($it['category'] ?? ''),
    'client' => (string) ($it['client'] ?? ''),
    'amount' => round((float) money_num($it['amount'] ?? 0), 2),
    'cadence' => in_array($it['cadence'] ?? '', $cadences, true) ? $it['cadence'] : 'once',
    'date' => (string) ($it['date'] ?? ''),
    'until' => (string) ($it['until'] ?? ''),
    'note' => (string) ($it['note'] ?? ''),
  ];
}

/* ============================================================
   AI brief — a compact planning summary for Ask / forecast so
   Claude can reason about client exposure and win/lose scenarios.
   ============================================================ */
function planning_brief(): string {
  $pipe = pipeline_compute();
  $s = $pipe['summary'];
  $cf = cashflow_compute();
  $h = $cf['headline'];
  $lines = [];

  $lines[] = "Pipeline & cash (planning):";
  $lines[] = sprintf("  Agreed recurring (MRR): £%s/mo; agreed one-off (won projects): £%s.",
    number_format($s['committedMrr'], 0), number_format($s['committedProject'], 0));
  if ($s['openCount'] > 0) {
    $lines[] = sprintf("  Open pipeline: %d opportunities, weighted £%s/mo recurring + £%s one-off.",
      $s['openCount'], number_format($s['weightedMrr'], 0), number_format($s['weightedProject'], 0));
  }
  if ($s['topClient']) {
    $lines[] = sprintf("  Client concentration: %s is %.0f%% of the committed book.", $s['topClient'], $s['topClientShare']);
  }
  $lines[] = sprintf("  Cash now: total £%s, available (ex-VAT set-aside £%s) £%s.",
    number_format($h['totalCash'], 0), number_format($h['vatSetAside'], 0), number_format($h['availableCash'], 0));
  $lines[] = sprintf("  13-week forecast closing cash: committed £%s; with selected pipeline £%s. (%s)",
    number_format($h['endCommitted'], 0), number_format($h['endScenario'], 0), $h['runwayNote']);

  // Name the open opportunities so "if we win X / lose Y" can be reasoned about.
  $open = array_values(array_filter($pipe['opps'], fn($o) => !in_array($o['stage'], ['won', 'lost'], true)));
  if ($open) {
    $lines[] = "  Open opportunities:";
    foreach (array_slice($open, 0, 12) as $o) {
      $unit = $o['type'] === 'retainer' ? '/mo' : ' one-off';
      $lines[] = sprintf("    - %s: £%s%s, %s (%d%%)%s", $o['client'] ?: 'unnamed', number_format($o['value'], 0), $unit, $o['stage'], $o['probability'], $o['startDate'] ? ', starts ' . $o['startDate'] : '');
    }
  }
  return implode("\n", $lines);
}
