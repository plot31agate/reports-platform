<?php
/* xero-config.php — the Xero OAuth 2.0 app credentials for live sync.

   The REAL file is gitignored AND deploy-excluded, and uploaded to the server
   by hand:  FTP -> /public_html/finance/api/xero-config.php

   To get these:
     1. Sign in at https://developer.xero.com/app/manage and create an app
        (type: "Web app").
     2. Set the redirect URI to EXACTLY this file's public URL. Finance HQ lives
        in the /finance folder of the reports subdomain, so it is:
          https://reports.digital-footprints.co.uk/finance/api/xero.php
     3. Copy the Client id and generate a Client secret.
     4. Copy this file to xero-config.php and fill them in.

   Scopes requested (read-only + refresh): offline_access, accounting.reports.read,
   accounting.settings.read. Finance HQ never writes to Xero. */
return [
  'client_id' => 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'client_secret' => 'your-client-secret',
  // Must byte-for-byte match the redirect URI registered on the Xero app.
  'redirect_uri' => 'https://reports.digital-footprints.co.uk/finance/api/xero.php',
];
