<?php
// Webhook called by GitHub Actions after FTP deploy to restart the reporting service.
// Token arrives in X-Deploy-Token header (never in URL — keeps it out of Apache logs).

$expected = 'XEarHCsRM4NWc8XDRz_rXAVeEEz9-0qX_Bn7M12X-Cw';

$provided = $_SERVER['HTTP_X_DEPLOY_TOKEN'] ?? '';

if (!hash_equals($expected, $provided)) {
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
