<?php
// Webhook called by GitHub Actions after FTP deploy to restart the reporting service.
// Token arrives in X-Deploy-Token header (never in URL — keeps it out of Apache logs).
//
// The token itself lives in deploy-token.php NEXT TO THIS FILE ON THE SERVER,
// never in this file and never in git (same pattern as finance's
// claude-config.php). Create it by hand in the webroot — a one-line PHP file
// that returns the token string (no closing tag) — and chmod it 600. Put the
// same value in the repo's DEPLOY_WEBHOOK_TOKEN Actions secret.

$tokenFile = __DIR__ . '/deploy-token.php';
$expected = is_file($tokenFile) ? (string) (include $tokenFile) : '';

$provided = $_SERVER['HTTP_X_DEPLOY_TOKEN'] ?? '';

if ($expected === '' || !hash_equals($expected, $provided)) {
    http_response_code(403);
    exit('Forbidden');
}

// No request input reaches the shell — commands are fully hardcoded.
// Install any new Python deps first (runs as the app user, no sudo needed),
// then restart. Allow time for a cold pip run.
set_time_limit(300);
shell_exec('cd /home/wwwdfootdigi/apps/reporting && ./venv/bin/pip install -q -r requirements.txt 2>&1');
shell_exec('sudo /bin/systemctl restart reporting 2>&1');
sleep(3);
echo "Deploy successful\n";
