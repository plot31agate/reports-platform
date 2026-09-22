# Reconciliation — Blueprint vs What's Actually Built

As of 2026-09-22, against the `plot31agate/reports-platform` repository
(this repo, current branch). Method: read the route surface (`app/main.py`),
the Agency HQ SPA views (`agency/src/`), templates, connectors, parsers, and
searched the whole tree for the blueprint's concepts (Buffer, Studio, Push,
Leads Central, plan-month, sign-off, etc.).

> **Important discrepancy to resolve first.** In conversation the modules were
> said to be built. **In this repository they are not** — see below. The most
> likely explanation is that the built client-facing modules live in a
> *different repo* that isn't attached to this session, or aren't pushed here.
> This reconciliation reflects only what's in this repo. If the loop is built
> elsewhere, point me at that repo and I'll redo this against it.

---

## Summary

| Blueprint stage | State in this repo |
|---|---|
| **Report** (end of month) | ✅ **Built & live** — full pipeline |
| **Agency HQ** (internal ops) | ✅ Built — DF's cross-client ops tool |
| **Client portal** (report delivery) | ✅ Built — report viewing only |
| **Client HQ dashboard** (client-facing) | ❌ Not built (portal ≠ dashboard) |
| **Plan** (start of month) | ❌ Not built (only a strategy *tracking* view) |
| **Make** — Studio + Content | ❌ Not built |
| **Push** — Buffer / schedule / sign-off | ❌ Not built (no Buffer anywhere) |
| **Leads Central** (WordPress plugin) | ❌ Not built (only a leads CSV parser) |

Built today = **the end-of-month Report + the internal machine around it.**
The client-facing monthly loop (Plan → Make → Push, and the Client HQ
dashboard) and Leads Central are **not** in this codebase.

---

## What IS built (verified)

**Report module — the live product.** Upload/sync of ~17 data sources →
parse → Claude sentiment + synthesis → branded HTML + PDF → review/edit →
share. Routes: `/admin/workspace`, `/admin/build-report`, `/admin/review`,
`/admin/share`; code in `app/reports/*`, `app/templates/report.html`,
`app/sentiment.py`, `app/assist.py`.

**Connectors.** Ahrefs, Google (GA4 + Search Console), Meta, Serper
(mentions) — `app/connectors/*`.

**Agency HQ (internal ops SPA).** `agency/src/views/`: Overview, ThisWeek,
Strategy, Clients, ClientPage, NewClientWizard, Reminders. This is DF's own
cross-client command centre — derived task list, estate-health sweep,
new-client wizard, credential vault. It is **not** the client-facing loop.
Note: `Reminders` is a *preview* of a digest, not a live scheduler; the
roster model (`agency/src/lib/roster.ts`) has explicit placeholder fields
"where real Client HQ health/approval data plugs in later" — i.e. stubs.

**Client portal (report delivery).** Magic-link invites, lists a client's
published reports (web + PDF), revocable share tokens, view tracking, curated
docs. Routes `/portal/*`, `/r/{token}`, `/d/{slug}/{name}`;
`app/templates/portal/*`.

**Client HQ provisioning.** `scripts/hq_builder.py` + `/agency/api/.../build-hq`
build a *bespoke external website* via the Claude Code CLI (dry-run by
default). This is site-generation, **not** the in-app Client HQ dashboard the
blueprint describes.

**Finance HQ.** Separate internal DF finance tool (`finance/`). Not part of
the client product.

## What is NOT built (the blueprint's client-facing loop)

- **Plan** — no Plan-Month calendar, no suggested-strategy (3 things,
  accept/reject, outcome+tactics), no drag-drop, export, reminder pings, or
  share-for-sign-off. Agency HQ's `Strategy.tsx` is a strategy-*tracking*
  view (focus + freshness), not the planning module. No calendar/plan backend
  routes exist.
- **Make** — no Studio (template upload, reuse-plan, reels, tick-off calendar
  → social queue) and no Content workspace (ideas board, draft, review, SEO,
  image add). None of these exist.
- **Push** — **no Buffer integration** anywhere (the only "scheduler" hits are
  React's internal npm package). No schedule / push-to-live / pre-publish
  sign-off.
- **Client HQ dashboard** — no client-facing first-load walkthrough, stepped
  setup, or "Dashboard HQ" (report stats + this week needs). "This week needs"
  and Overview exist only in the *Agency* HQ (DF's internal view), not a
  client dashboard.
- **Leads Central** — **no WordPress plugin** at all. `app/ingestion/parsers/
  leads.py` is only a CSV parser feeding one number into the report's
  at-a-glance. No lead scoring, follow-up automation, CRM connect, or the
  plugin itself.

## Partial foundations we can build ON (not the feature, but a head start)

- **Strategy tracking** (Agency HQ) → foundation for **Plan**.
- **Client portal** → foundation for the **Client HQ dashboard**.
- **Agency HQ task engine** (ThisWeek/Overview) → foundation for
  "this week needs".
- **Leads CSV parser + at-a-glance** → the data path **Leads Central** would
  eventually feed.
- **Report synthesis** already produces recommended actions + the "why" — that
  is exactly what **Plan** should consume to close the report→plan loop. The
  producing side exists; the consuming (Plan) side does not.

## Bottom line for building

If this repo is the build target, we are building **the client-facing monthly
loop from scratch on top of a strong, live reporting core** — not polishing
existing modules. That is a real, multi-module build, which is why the
`CLAUDE.md` and `build-backlog.md` are scoped that way.

**Before anyone builds:** confirm whether the loop already exists in another
repo. If yes, attach it and this doc gets redone. If no, the backlog is the
plan.
