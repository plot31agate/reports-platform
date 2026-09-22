# CLAUDE.md — orientation for Claude Code sessions

Read this first. It describes what this project actually is, how it's laid
out, and where the build is heading. For the product vision see
`docs/platform-blueprint.md`; for the honest built-vs-unbuilt map see
`docs/reconciliation.md`.

## What this is

Digital Footprints' agency platform. Today it is **an in-house tool centred on
a live monthly reporting product**, with an internal ops console around it.
The wider vision is a full **monthly client operating loop**
(Client HQ → Plan → Make → Push → Report) plus a **Leads Central** WordPress
plugin — most of which is **not built yet** (see `docs/reconciliation.md`).

Do not assume the Plan / Make / Push / Client-HQ-dashboard / Leads Central
modules exist. They don't, in this repo. Verify against the code before
building on any assumption.

## The three apps in this repo

1. **`app/` — Reporting core (LIVE).** Python / FastAPI + Jinja2 templates +
   SQLite, WeasyPrint/Chromium for PDF, Claude API for sentiment + synthesis.
   - Routes: all in `app/main.py` (admin workspace, report build/review,
     client portal, sharing, the `/agency/api/*` backend).
   - Report pipeline: `app/reports/*` (builder, sections, glance, trends,
     jobs, pdf). Data ingestion: `app/ingestion/parsers/*`. External data:
     `app/connectors/*` (Ahrefs, Google GA4+GSC, Meta, Serper).
   - AI: `app/sentiment.py`, `app/assist.py`, models configured in
     `app/config.py`. Auth: `app/auth.py` (single admin + client portal
     magic-links). Secrets vault: `app/vault.py`.
   - Templates: `app/templates/` (`admin/`, `portal/`, `report.html`).

2. **`agency/` — Agency HQ (LIVE, internal).** Vite + React 18 + TypeScript
   SPA, served by the FastAPI app at `/agency`. DF's cross-client ops console:
   `agency/src/views/*` (Overview, ThisWeek, Strategy, Clients, ClientPage,
   NewClientWizard, Reminders). Talks to `/agency/api/*`. This is the
   *agency's* tool, not the client-facing loop.

3. **`finance/` — Finance HQ (LIVE, internal, separate).** Vite + React + TS
   SPA with a **PHP flat-file backend** (`finance/public/api/*.php`). DF's own
   finance dashboard. Unrelated to the client product — don't entangle it.

## How it runs / builds / deploys

- Python deps: `requirements.txt`. Config via `.env` (see `.env.example`).
- Agency HQ / Finance HQ: standard Vite (`npm install` + `npm run build` in
  each dir). Agency HQ builds into what the FastAPI app serves at `/agency`.
- Deploy: GitHub Actions in `.github/workflows/` (push to `main` builds +
  FTPS-deploys + restarts the systemd service; finance deploys separately).
  The live DB, `.env`, and uploaded data are excluded from deploys.
- To run/verify the app locally, prefer the `run` skill; otherwise start the
  FastAPI app and hit `/health`.

## Conventions

- **Multi-client from day one** — data is keyed by `client_slug`; clients live
  in the DB (`app/clients/` is seed data only). Don't hardcode client logic.
- **Connectors** light up only when the agency key + required per-client
  fields exist; secret fields are write-only (never re-displayed).
- **Reports are per client + per period** (`YYYY-MM` or a custom range —
  `app/periods.py`). Operator edits must survive rebuilds (AI text is
  fingerprinted — see the review machinery in `app/main.py` + `app/reports/`).
- Match the existing style of whichever app you're in (FastAPI/Jinja in
  `app/`, React/TS in `agency/` and `finance/`). No cross-app imports.
- Keep secrets out of the repo. Never commit `.env` or live data.

## Where the build is heading

The near-term build is the **client-facing monthly loop** on top of the live
reporting core. The sliced, ordered plan with acceptance criteria is in
`docs/build-backlog.md`. Build thin vertical slices, one module at a time,
reusing the foundations named in `docs/reconciliation.md`. The loop's backbone
is Report → Plan: recommended actions from the report feed next month's plan.

## Docs map

- `docs/platform-blueprint.md` — the product/process vision (from the notebook).
- `docs/reconciliation.md` — blueprint vs what's actually built (read before building).
- `docs/build-backlog.md` — the sliced, ordered build plan.
- `docs/sales-brief.md` — how the platform is described to market.
- `docs/commercialisation-plan.md` — how it's sold (GTM).
- `README.md` — deployment/setup detail.
