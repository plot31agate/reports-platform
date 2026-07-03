# Digital Footprints Reporting Platform

Branded monthly PR + growth reporting dashboards for agency clients.
V1 client: Sportingtech.

- **Live URL:** https://reports.digital-footprints.co.uk
- **Stack:** FastAPI + Jinja2 + WeasyPrint + SQLite, Claude API for sentiment and synthesis
- **Hosted on:** AlmaLinux 8.10 VPS, systemd service, Apache reverse proxy

---

## What this platform does

Turns API syncs (Ahrefs, GA4, Search Console) and CSV / XLSX exports
(LinkedIn, Google Alerts) into a branded monthly report with eight sections:

1. Media coverage
2. Share of voice
3. Executive mentions
4. Sentiment tracking (Claude API, iGaming-context-aware)
5. Website traffic
6. Referring domains
7. Campaign & event performance
8. Next month's actions (synthesised by Claude from all the above)

Each report renders as a shareable branded web page and a PDF export.
Client-facing shareable links skip login; admin area is password-protected.

Multi-client from day one — add a new client by dropping a new file in
`app/clients/` and registering it in `app/clients/__init__.py`.

---

## First-time GitHub setup

If the repo doesn't exist yet:

```bash
cd /path/to/this/project
git init
git add .
git commit -m "Initial scaffold — v1 platform, Sportingtech as client #1"

# Create the repo on github.com (private is fine), then:
git remote add origin git@github.com:YOUR-USERNAME/reports-platform.git
git branch -M main
git push -u origin main
```

Add the following **repository secrets** in GitHub → Settings → Secrets and variables → Actions:

| Secret         | Value |
|----------------|-------|
| `VPS_HOST`     | Your VPS hostname or IP |
| `VPS_USER`     | `wwwdfootdigi` |
| `VPS_SSH_KEY`  | Contents of a private SSH key that can log in as wwwdfootdigi (see below) |
| `VPS_PORT`     | 22 (or your custom port) |

To create the deploy SSH key:

```bash
# On your laptop
ssh-keygen -t ed25519 -f ~/.ssh/df_deploy -C "df-github-deploy" -N ""

# Copy public key onto the VPS
ssh root@YOUR_VPS "mkdir -p /home/wwwdfootdigi/.ssh && chmod 700 /home/wwwdfootdigi/.ssh"
ssh root@YOUR_VPS "cat >> /home/wwwdfootdigi/.ssh/authorized_keys" < ~/.ssh/df_deploy.pub
ssh root@YOUR_VPS "chmod 600 /home/wwwdfootdigi/.ssh/authorized_keys && chown -R wwwdfootdigi:wwwdfootdigi /home/wwwdfootdigi/.ssh"

# Paste the PRIVATE key (contents of ~/.ssh/df_deploy) into VPS_SSH_KEY secret
cat ~/.ssh/df_deploy
```

Give wwwdfootdigi passwordless sudo for the one command it needs:

```bash
ssh root@YOUR_VPS
echo 'wwwdfootdigi ALL=(ALL) NOPASSWD: /bin/systemctl restart reporting' > /etc/sudoers.d/wwwdfootdigi-restart
chmod 440 /etc/sudoers.d/wwwdfootdigi-restart
```

---

## First-time VPS setup

The plumbing (Python 3.11, Cairo/Pango, Apache proxy, systemd service, subdomain)
was completed in the initial setup conversation. What remains is putting the real
app in place.

### 1. Clone the repo onto the VPS

```bash
sudo -u wwwdfootdigi git clone git@github.com:YOUR-USERNAME/reports-platform.git /home/wwwdfootdigi/apps/reporting-new
```

Note: cloning to `-new` first so we don't disturb the placeholder that's already
running there.

### 2. Set up the virtualenv and install dependencies

```bash
cd /home/wwwdfootdigi/apps/reporting-new
sudo -u wwwdfootdigi python3.11 -m venv venv
sudo -u wwwdfootdigi ./venv/bin/pip install --upgrade pip
sudo -u wwwdfootdigi ./venv/bin/pip install -r requirements.txt
```

### 3. Create .env

```bash
sudo -u wwwdfootdigi cp .env.example .env
sudo -u wwwdfootdigi nano .env
```

Fill in:

- `SECRET_KEY` — run `python scripts/generate_secret.py` and paste
- `ADMIN_PASSWORD_HASH` — run `python scripts/hash_password.py` and paste
- `ANTHROPIC_API_KEY` — your Claude API key

### 4. Swap the placeholder for the real app

```bash
cd /home/wwwdfootdigi/apps
sudo systemctl stop reporting
sudo -u wwwdfootdigi mv reporting reporting-placeholder
sudo -u wwwdfootdigi mv reporting-new reporting
```

### 5. Update systemd to point at the new app module

The placeholder ran `main:app`. The real app runs `app.main:app`.

```bash
sudo cp deploy/reporting.service /etc/systemd/system/reporting.service
sudo systemctl daemon-reload
sudo systemctl start reporting
sudo systemctl status reporting
```

### 6. Update Apache proxy to include /static/

The proxy config needs one addition to serve static assets (CSS, images). Edit both files:

```bash
sudo nano /etc/apache2/conf.d/userdata/std/2_4/wwwdfootdigi/reports.digital-footprints.co.uk/proxy.conf
sudo nano /etc/apache2/conf.d/userdata/ssl/2_4/wwwdfootdigi/reports.digital-footprints.co.uk/proxy.conf
```

Replace contents of each with `deploy/apache-proxy.conf` (adjusting X-Forwarded-Proto for http vs https).

Then rebuild + restart:

```bash
sudo /scripts/ensure_vhost_includes --user=wwwdfootdigi
sudo /scripts/rebuildhttpdconf
sudo systemctl restart httpd
```

### 7. Verify

```bash
curl https://reports.digital-footprints.co.uk/health
```

Should return `{"status":"ok"}`. Then open the URL in a browser — you should
see the login page.

---

## The monthly workflow (once running)

1. **Export CSVs** from each tool (~30 min):
   - Ahrefs: Site Explorer → Backlinks → Export → `ahrefs_backlinks_YYYY-MM.csv`
   - GA4: Reports → Export → `ga4_export_YYYY-MM.csv`
   - Search Console: Performance → Export → `search_console_YYYY-MM.csv`
   - LinkedIn: Analytics → Export → `linkedin_company_YYYY-MM.xlsx`
   - Google Alerts / mentions: compile from Gmail into `mentions_YYYY-MM.csv`
     (columns: date, source, title, url, snippet)

2. **Log in** at https://reports.digital-footprints.co.uk/admin

3. **Open the month's workspace** (client card → "Open workspace", or sidebar).
   Drop all export files onto the single dropzone — each routes to its source
   automatically and confirms what was parsed. Unrecognised filenames get a
   manual "which source is this?" prompt instead of failing silently.

4. **Build** — runs in the background with live progress (parsing → sentiment →
   recommendations → render). Sentiment results are cached per mention, so
   rebuilds are near-instant. If the AI layer is unavailable or partially
   fails, the build finishes but flags it loudly instead of shipping silent
   neutral scores.

5. **Review & edit** the commentary in place, then deliver: clients with
   portal access see the published report immediately at `/portal`, or send a
   90-day share link (revocable, view-tracked) / PDF.

Total human time each month: ~30-45 minutes.

---

## API connections (skip the CSV exports)

Two halves, reflecting how the accounts actually work:

- **Agency keys** (Admin → API keys, one per provider, shared by every
  client): the Ahrefs API key and one Google service account JSON that
  covers GA4 traffic, GA4 geography, and Search Console. Each card has a
  "How do I get this key?" walkthrough.
- **Client settings** (workspace → "API connections" panel): which target
  domain and Site Audit project ID (Ahrefs), GA4 property ID and Search
  Console property to pull for that client. For Google, the service
  account's email must be added as a viewer on each client's GA4 property
  and Search Console site.

Ahrefs also feeds the monthly technical SEO metrics (Site Audit health
score, DR, open-issue counts) with history carried forward so
month-over-month deltas keep working. The curated issue register stays a
manual upload — it holds the agency's judgement, which an API can't supply.
The site health score also appears as a tile on the report cover.

Similarweb was retired: GA4 geography feeds the report's Geography section
with real measured country data. Old months built from Similarweb uploads
still render.

Save → Test connection → connected sources grow a **Sync** button in the
workspace (plus "Sync all connected"). A sync pulls the period's data from
the API, writes it as the same CSV shape the parser already reads, and the
rest of the pipeline is identical to an upload. Secret keys are write-only:
once saved they're never displayed again; leave the field blank to keep the
stored value. LinkedIn and Google Alerts have no key-based API — those stay
on upload / auto-fetch.

---

## Client portal

Each client contact gets a personal access link (Admin → Portal access →
add email → copy link). Opening it signs them into a branded portal listing
every published report for their company — web + PDF, no password. Access is
revocable per person and takes effect immediately. Report opens (portal and
share links) are tracked per viewer.

---

## Expected filename patterns

The parser routes files based on filename prefix. Anything containing these
strings gets parsed by the matching parser:

| Prefix               | Parser                    |
|----------------------|---------------------------|
| `ahrefs_backlinks`   | Ahrefs backlinks          |
| `similarweb_traffic` | Similarweb traffic        |
| `ga4_export`         | GA4 analytics             |
| `search_console`     | Google Search Console     |
| `linkedin_company`   | LinkedIn company page     |
| `mentions`           | Media mentions (for sentiment) |

Filenames are flexible — `ahrefs_backlinks_june.csv`, `ahrefs_backlinks_2026-06.csv`,
and `sportingtech_ahrefs_backlinks.csv` all match.

---

## Adding a new client

Admin → "New client". No deploy needed — clients live in the DB (the
`clients` table is the single source of truth; code modules like
`sportingtech.py` are seed data only, copied in on first boot).

Brand tokens (colours, tagline, sentiment context) are per-client, so
each report renders with the correct brand identity.

---

## Local development

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in .env with dev values (SECRET_KEY, ADMIN_PASSWORD_HASH, ANTHROPIC_API_KEY)
uvicorn app.main:app --reload --port 8001
```

Open http://127.0.0.1:8001/ — logs in at `/admin/login`.

Test with sample data:

```bash
mkdir -p data/sportingtech/2026-06
cp sample_data/* data/sportingtech/2026-06/
```

Then in the admin UI, run "Upload & build" against the sportingtech / 2026-06
period, and the report renders using the sample data.

---

## Ongoing deploys

Push to `main` on GitHub. Actions SSHes to the VPS, pulls, installs any new
dependencies, restarts the service, and verifies `/health` responds. Failed
health check = failed deploy = you get a red build.

For urgent hotfixes SSH is always available:

```bash
ssh wwwdfootdigi@YOUR_VPS
cd apps/reporting
git pull
sudo systemctl restart reporting
```

---

## Where things live

```
/home/wwwdfootdigi/apps/reporting/     app code (this repo)
                              /data/   uploaded CSVs by client + period
                              /reports_out/  generated HTML + PDF
                              /reporting.db  SQLite: clients, reports, share tokens
                              /.env    secrets (never committed)
                              /venv/   Python virtualenv
/etc/systemd/system/reporting.service  service unit
/etc/apache2/conf.d/userdata/...       reverse proxy config
```

---

## Roadmap — what's not in V1

Deliberately left for V2:

- Google Drive integration (upload UI covers V1 needs)
- Direct API pulls (Ahrefs, Similarweb, GA4) replacing CSV exports
- Auto-run on cron
- Multi-user admin (currently one admin login)
- Executive mention filtering from within the mentions CSV
- Historical charts (MoM trend lines on each KPI)
- Per-client logo upload rather than baked into CSS
- Client-side login (currently only signed link tokens for clients)

Each can be added without restructuring — the parsers, sentiment, PDF renderer
all stay identical.
