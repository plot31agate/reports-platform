<?php
/* forecast.php — scenario planning and what-if review.

   POST {scenario, changes?}
     scenario — the owner's what-if in plain English, e.g. "we hire a second
                developer at £4k/month and lift marketing by 50%".
     changes  — optional structured deltas the UI computed from its sliders
                (revenuePct, costPct, cashNow, projectedNet…) so the narrative
                and the on-screen maths agree.
   -> { ok, result: { summary, impacts:[{label,value}], risks:[...], actions:[...] } }

   The deterministic maths (runway, projected cash) is done in the browser; this
   endpoint adds the judgement: what it means, what to watch, what to do. */
require __DIR__ . '/claude.php';
require __DIR__ . '/planning.php';   // pulls model.php; adds pipeline + cash context

$b = body_json();
$scenario = trim((string) ($b['scenario'] ?? ''));
if ($scenario === '') fail('describe the scenario');
if (mb_strlen($scenario) > 600) $scenario = mb_substr($scenario, 0, 600);

$brief = finance_brief();
if (str_starts_with($brief, 'No financial data')) {
  respond(['ok' => false, 'error' => 'Import a Xero report first — there is nothing to plan against yet.']);
}

// Fold the UI's computed figures into the prompt so Claude reasons about the
// same numbers the screen shows.
$changes = is_array($b['changes'] ?? null) ? $b['changes'] : [];
$ctx = '';
if ($changes) {
  $ctx = "\n\nThe dashboard has modelled this scenario as:\n";
  foreach ($changes as $k => $v) {
    if (is_scalar($v)) $ctx .= "  - $k: $v\n";
  }
}

$schema = [
  'type' => 'object',
  'properties' => [
    'summary' => ['type' => 'string', 'description' => 'What this scenario does to the finances, in 2–4 plain sentences.'],
    'impacts' => [
      'type' => 'array',
      'description' => 'The headline effects as label/value pairs (e.g. "Monthly net profit", "−£1,200").',
      'items' => [
        'type' => 'object',
        'properties' => ['label' => ['type' => 'string'], 'value' => ['type' => 'string']],
        'required' => ['label', 'value'],
        'additionalProperties' => false,
      ],
    ],
    'risks' => ['type' => 'array', 'description' => 'What to watch — 2–4 concrete risks or assumptions.', 'items' => ['type' => 'string']],
    'actions' => ['type' => 'array', 'description' => '2–4 specific, prioritised recommendations.', 'items' => ['type' => 'string']],
  ],
  'required' => ['summary', 'impacts', 'risks', 'actions'],
  'additionalProperties' => false,
];

$user = "Here is Digital Footprints' financial data:\n\n$brief\n\n" . planning_brief() . "\n\n"
  . "Scenario to assess: $scenario$ctx\n\n"
  . "Assess it against the real figures. Be concrete and quantify where you can, "
  . "in £. Flag the biggest risk to cash. Keep advice practical for a small UK business.";

$out = claude_json(claude_system(), $user, $schema, 1600);
respond(['ok' => true, 'result' => $out]);
