<?php
/* claude-config.php — the live Anthropic API key for the AI features
   (Ask the data, scenario planning, and the board-report/tax work to come).

   The REAL file is gitignored AND excluded from any deploy workflow, and is
   uploaded to the server by hand:
     FTP -> /public_html/finance/api/claude-config.php

   Copy this file to claude-config.php and fill in the key from
   platform.claude.com. Never commit the real file. Without it, the AI features
   return {needsKey:true} and the rest of the dashboard works as normal. */
return [
  // Standard API key (recommended for the server)
  'api_key' => 'sk-ant-...',

  // OR a short-lived OAuth bearer token (local testing):
  // 'auth_token' => '...',

  // Optional: the Monday-morning digest email the daily cron sends (position,
  // pace, open questions, who's gone quiet). Leave 'digest_to' empty (or omit
  // it) and no email is ever sent. 'digest_from' defaults to
  // finance@<this-domain> if omitted.
  // 'digest_to' => 'you@example.co.uk',
  // 'digest_from' => 'finance@example.co.uk',
];
