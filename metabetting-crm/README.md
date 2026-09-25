# Meta Betting CRM Snapshot (v1)

Single-page tool for turning what we find in Meta Betting's Customer.io data into
a funnel, legal audience, segment build plan, Swifty data requests, opportunity
estimate, roadmap and a one-page client summary. Full brief:
`../../metabetting-crm/meta-betting-crm-snapshot-brief.md`.

- **Live:** https://reports.digital-footprints.co.uk/metabetting-crm/ (admin login)
- **Dev:** `npm run dev` → http://localhost:5177/metabetting-crm/
- **Deploy:** push to `main`. `deploy.yml` builds this app next to Agency HQ and
  ships only `dist/`; the reporting app mounts it at `/metabetting-crm`.

## Data handling
Counts only. State lives in the browser's localStorage; **Export JSON** saves a
snapshot per meeting/month, **Import JSON** loads one back, and the summary can
load an earlier JSON to compare against. No network calls, no backend, no web fonts.

## Layout
- `src/lib/model.ts`: snapshot shape, audit checklist, segments, abuse signals, example data
- `src/lib/calc.ts`: every derived figure (null in → "—" out), build specs, roadmap
- `src/lib/summary.ts`: one-page summary + Markdown (same content)
- `src/views/*`: one file per section (3.1–3.8 in the brief)

v2 (CSV mode) and v3 (live Customer.io API) are not built yet.
