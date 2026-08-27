# Finance HQ

Digital Footprints' internal **finance & reporting dashboard**. Upload Xero
reports, see the numbers at a glance, interrogate them in plain English with
Claude, budget by spend layer, and forecast cash — all behind one login, in the
DF portal style.

It's a sibling of the client [`portal/`](../portal): same stack (Vite + React +
TypeScript on the front, PHP flat-file + the Anthropic Messages API on the back),
same design system, same cPanel + Basic Auth deployment. Unlike the portal there
is one business here (DF itself), configured in `src/lib/client.ts`.

## What it does today

| Room | What it does |
| --- | --- |
| **Dashboard** | First-look KPIs (revenue, gross/net profit, cash) with month-on-month deltas, the income/cost/profit trend, top spend, cash runway, and a plain-English read of what changed. |
| **Import** | **Connect Xero for live sync** (OAuth 2.0, read-only — one click pulls the last 12 months of P&L and the balance sheet), or drop/paste a Xero **Profit & Loss** / **Balance Sheet** CSV export. Either way the parser reports exactly what it found. Manual balance entry too. |
| **Ask the data** | Interrogate the numbers in plain English. Answers are grounded only in what you've imported — Claude won't invent figures. |
| **Budgets & Forecast** | Spend layers ("what we should spend on X") vs actuals with variance bars; a 12-month cash runway projection; and what-if sliders + a free-text scenario Claude assesses against the real figures. |
| **Board Reports** | Generate a Claude-written board pack over a month's figures (executive summary, performance, cash, risks, recommendations, a UK tax note, outlook), then hand it to a director via a **read-only share link** — no login, HMAC-guarded (`board.php`). |

On the roadmap: clients / projects / timesheets with per-client profitability,
tax-liability deep-dives, and automated reminders.

## Live Xero sync

Read-only, OAuth 2.0. To enable, register a **Web app** at
[developer.xero.com](https://developer.xero.com/app/manage), set its redirect
URI to `https://<your-domain>/finance/api/xero.php`, and copy
`api/xero-config.example.php` to `api/xero-config.php` with the client id,
secret and that redirect URI. Then **Import → Connect Xero**. Scopes requested:
`offline_access accounting.reports.read accounting.settings.read` — Finance HQ
never writes to Xero. Tokens live in the flat store (behind Basic Auth,
gitignored, never served); the refresh token rotates on each sync. The CSV
importer and the API sync share one classifier (`classify.php`), so an upload
and a pull produce identical months.

### Automatic daily pull + board report

`api/cron-sync.php` is a **command-line job** (it refuses to run over the web)
that runs the same sync the button does, then auto-writes the board report for
the most recent **completed** month — once, so daily runs keep the figures fresh
without stacking up a new AI pack every day. It reuses `xero_run_sync()` and
`board_generate()`, the exact code the UI calls, so automatic and manual runs
are identical.

Prerequisites: `xero-config.php` + `claude-config.php` in place, and Xero
connected once in the browser (that one OAuth consent can't be scripted). After
that it runs unattended — the refresh token rotates on each run and stays valid
as long as the job runs within any 60-day window.

Wire it up as a cPanel **Cron Job**, daily:

```
/usr/local/bin/php /home/wwwdfootdigi/public_html/reports.digital-footprints.co.uk/finance/api/cron-sync.php >> /home/wwwdfootdigi/finance-cron.log 2>&1
```

## Board report share links

Same HMAC trick as the client portal's plan links: the signing secret is
derived from the Anthropic key, so there's no extra secret to manage and
rotating that key instantly revokes every link ever sent. `board.php` is the
one public door (a `Require all granted` exception in `.htaccess`); it verifies
the token, renders a single stored report as a branded, print-ready page, and
can write nothing.

## The data model

Everything is flat JSON under `public/data/` (never a database, never served
directly — see `data/.htaccess`). `model.php` is the single definition of "the
numbers": a period is one month keyed `YYYY-MM`, its P&L grouped into `income`,
`cogs`, `opex`, `otherIncome`, `otherExpense` so gross and net profit are
unambiguous. `finance.php` serves the computed model; `ask.php` / `forecast.php`
feed a compact brief of it to Claude. Money is stored as plain GBP numbers;
"£" formatting happens in the browser.

## Run it locally

```bash
# backend (PHP built-in server, serves the API)
php -S 127.0.0.1:8941 -t public

# frontend (Vite dev server, proxies /api to the PHP server)
npm install
npm run dev            # http://localhost:5175
```

The AI features need `public/api/claude-config.php` (copy from
`claude-config.example.php` and add an Anthropic key). Everything else works
without it.

## Deploy — push-to-live to `reports.<domain>/finance/`

Finance HQ lives in the **`/finance` subfolder of the `reports` subdomain** on
the **plot31agate** cPanel account, alongside (but isolated from) the existing
reporting module at the subdomain root. It keeps its **own** Basic Auth login.

Live at **`https://reports.digital-footprints.co.uk/finance/`** (behind its own
Basic Auth). Because it's a Vite app, the deploy **builds in CI** — see
[`.github/workflows/deploy-finance.yml`](../.github/workflows/deploy-finance.yml).
A push to `main` touching `finance/**` runs `npm run build` (which copies the PHP
backend in `public/` into `dist/`, so `dist/` is the whole `/finance/` payload)
and FTPS-uploads `dist/` into `apps/finance/`.

It deploys into the reports subdomain web root at
`/home/wwwdfootdigi/public_html/reports.digital-footprints.co.uk/finance`, where
PHP and the `.htaccess` auth run natively (docroot = automatic AllowOverride All
+ PHP-FPM). The reporting deploy's FTP login is jailed to `apps/reporting` and
can't reach the web root, so finance uses the **main `wwwdfootdigi` cPanel FTP
login** (jailed to the home dir) via its own secrets. The reporting deploy is
untouched.

**One-time server setup (by hand, never in git):**

1. **The proxy hole.** Add `ProxyPass /finance/ !` from
   [`deploy/apache-proxy.conf`](../deploy/apache-proxy.conf) to the live reports
   vhost includes (next to `/vivogaming/ !`), then rebuild + restart httpd. This
   stops the FastAPI proxy from swallowing `/finance/`.
2. **GitHub secrets.** Repo → Settings → Secrets and variables → Actions:
   `FTP_SERVER` (reused), plus `FTP_FINANCE_USERNAME` / `FTP_FINANCE_PASSWORD`
   set to the **main `wwwdfootdigi` cPanel account** credentials.
3. **Its own login.** Create `.htpasswd` at
   `/home/wwwdfootdigi/public_html/reports.digital-footprints.co.uk/finance/.htpasswd`
   (cPanel → Directory Privacy on the finance folder, or `htpasswd -c`). Realm
   `Digital Footprints · Finance HQ`; fails closed until it exists.
4. **The secret configs**, uploaded once to the finance `api/` folder:
   - `claude-config.php` (Anthropic key) — for Ask, scenarios, board reports.
   - `xero-config.php` (Xero app id/secret/redirect) — for live sync. Register
     `https://reports.digital-footprints.co.uk/finance/api/xero.php` as the Xero
     redirect URI.

The deploy's `exclude:` list protects all three of the above **and the live
`data/*.json` stores** — your imported figures, budgets and saved board reports
are never overwritten or deleted by a deploy.

**Everything behind auth except one door:** the whole app (including every API
endpoint) sits behind Basic Auth and is `noindex`. The single public exception
is `board.php`, which serves one board report to whoever holds its HMAC link
(share links auto-resolve to `reports.<domain>/finance/board.php`).

To go live the first time: merge this branch to `main` (or run the workflow
manually from the Actions tab once it's on `main`).

## Security notes

- **Auth**: one Basic Auth login guards everything; fail-closed on a bad
  `AuthUserFile` path.
- **CSRF**: the API requires `Content-Type: application/json`, which a
  cross-site form can't send.
- **Secrets**: the Anthropic key lives only in `claude-config.php`
  (gitignored + deploy-by-hand). Live JSON stores are gitignored too.
- **Grounding**: Claude only ever sees the compact finance brief, and is told
  never to invent numbers and to flag tax framing as an estimate to confirm
  with an accountant.
