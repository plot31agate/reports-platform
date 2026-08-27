<?php
/* pipeline.php — the lead pipeline: agreed (committed) vs potential work.

   GET   -> { ok, opps:[…computed], summary:{…}, stageProb:{…} }
   POST {action}:
     add    {client,type,value,stage,probability?,startDate?,decisionDate?,nextAction?}
     update {id, …any of the above, includeInForecast?}
     delete {id}
     seed                                   — a couple of example rows to start

   The maths (weighted value, MRR, concentration) lives in planning.php so the
   cash-flow forecast and the AI brief read the same pipeline. */
require __DIR__ . '/planning.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $out = pipeline_compute();
  respond(['ok' => true, 'opps' => $out['opps'], 'summary' => $out['summary'],
    'stageProb' => STAGE_PROB, 'stages' => STAGE_ORDER]);
}

$b = body_json();
$store = pipeline_store();
$action = $b['action'] ?? '';

/** Pull the editable fields out of a request body onto an opp. */
function opp_patch(array $o, array $b): array {
  $map = ['client', 'type', 'stage', 'startDate', 'decisionDate', 'nextAction'];
  foreach ($map as $k) if (array_key_exists($k, $b)) $o[$k] = (string) $b[$k];
  if (array_key_exists('value', $b)) $o['value'] = money_num($b['value']);
  if (array_key_exists('includeInForecast', $b)) $o['includeInForecast'] = (bool) $b['includeInForecast'];
  if (array_key_exists('probability', $b)) {
    $p = $b['probability'];
    $o['probability'] = ($p === null || $p === '') ? null : max(0, min(100, (int) $p));
  }
  return $o;
}

switch ($action) {
  case 'add': {
    $o = opp_patch(['id' => bin2hex(random_bytes(6)), 'stage' => 'lead', 'type' => 'retainer',
      'includeInForecast' => false, 'createdAt' => time()], $b);
    if (trim((string) ($o['client'] ?? '')) === '') fail('name the client / opportunity');
    $store['opps'][] = $o;
    store_write('pipeline', $store);
    respond(['ok' => true, 'opp' => opp_view($o)]);
  }
  case 'update': {
    $id = (string) ($b['id'] ?? '');
    foreach ($store['opps'] as $i => $o) {
      if (($o['id'] ?? '') === $id) {
        $store['opps'][$i] = opp_patch($o, $b);
        store_write('pipeline', $store);
        respond(['ok' => true, 'opp' => opp_view($store['opps'][$i])]);
      }
    }
    fail('not found', 404);
  }
  case 'delete': {
    $id = (string) ($b['id'] ?? '');
    $before = count($store['opps']);
    $store['opps'] = array_values(array_filter($store['opps'], fn($o) => ($o['id'] ?? '') !== $id));
    if (count($store['opps']) === $before) fail('not found', 404);
    store_write('pipeline', $store);
    respond(['ok' => true]);
  }
  case 'seed': {
    if ($store['opps']) fail('pipeline already has rows');
    $now = time();
    $store['opps'] = [
      ['id' => bin2hex(random_bytes(6)), 'client' => 'Example Retainer Co', 'type' => 'retainer',
        'value' => 1500, 'stage' => 'proposal', 'probability' => null, 'startDate' => '',
        'decisionDate' => '', 'nextAction' => 'Send proposal', 'includeInForecast' => false, 'createdAt' => $now],
      ['id' => bin2hex(random_bytes(6)), 'client' => 'Example Project Ltd', 'type' => 'project',
        'value' => 6000, 'stage' => 'verbal', 'probability' => null, 'startDate' => '',
        'decisionDate' => '', 'nextAction' => 'Confirm start date', 'includeInForecast' => true, 'createdAt' => $now],
    ];
    store_write('pipeline', $store);
    respond(['ok' => true, 'seeded' => count($store['opps'])]);
  }
}
fail('unknown action');
