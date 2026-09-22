# Build Backlog — the real roadmap

Updated 2026-09-22 once the client-facing loop was located in
`plot31agate/social-builder`. Read `docs/reconciliation.md` first — the loop
is **built** (per-client Client HQ portals), so this is **not** a "build the
loop" backlog. It's the work to make what exists scalable and complete.

Scope split:
- **`reports-platform`** (this repo): Report engine, Agency HQ, Client HQ
  provisioning, Finance HQ.
- **`social-builder`** (+ per-client clones): the Client HQ portal loop
  (Dashboard, Planner, Studio, Social/Push, Content, Reports room, Setup).

---

## The real problem to solve

The loop works in production, but it's delivered as **hand-cloned per-client
repos** (`social-builder`, `daisy-social-builder`, `igs-social-builder` …),
each brand-configured and deployed to its own cPanel folder, and they **drift**
(CLIENT.md notes YM is an "older-clone portal" that lost the runtime `modules`
toggle and needed manual re-pointing). The roadmap is about **repeatability,
not features.**

---

## Track 1 — Productise the Client HQ (highest leverage)

**Goal:** one template + per-client config, instead of N diverging clones.

- **Single source template.** One canonical Client HQ codebase; each client is
  **config**, not a fork. Kills clone drift.
- **Runtime `modules` toggle everywhere.** Every clone should honour the
  Setup → Rooms toggles (YM's clone lost this). Rooms on/off per client at
  runtime, no code edits.
- **Repeatable provisioning.** Harden the `client-hq` skill /
  `scripts/hq_builder.py` path in this repo so spinning up a new Client HQ is
  one reliable action (it currently defaults to dry-run). This provisioning IS
  the paid "Launchpad" from `docs/commercialisation-plan.md`.
- **Decision (?):** stay per-client-instance (simpler, current model, fits
  managed service) vs move to **multi-tenant** (needed only if self-serve SaaS
  is pursued — see commercialisation plan). Don't build multi-tenant on spec;
  gate it on the self-serve decision.

**Acceptance:** a new client can be stood up from the template + a config file
+ the provisioning action, with rooms selected at Setup, no code fork.

## Track 2 — Build Leads Central (the one missing module)

**Goal:** the blueprint's WordPress lead engine — the only piece not built in
either repo. Best treated as a **separate WordPress track / front-door
product** (per `docs/commercialisation-plan.md`).

- Monitor + score incoming leads; manage follow-ups; automated email
  follow-up sequences.
- Secure login; sales-tracking + acquisition reporting.
- Feed lead data back into the hub's Report (replacing the manual leads CSV
  path in `app/ingestion/parsers/leads.py`).
- **(?) decisions:** which CRMs to connect; snapshot-analysis scope; build
  fresh vs adapt an existing WP lead framework.

**Acceptance (v1):** plugin installs on a client WP site, captures + scores
leads, runs a follow-up sequence, and its numbers appear in that client's
monthly report.

## Track 3 — Tidy the seams between hub and Client HQ

Smaller, valuable consistency work:

- **Reporting handoff.** Keep the heavy report in the hub; make the Client HQ
  Reports room's link/headline-numbers pull consistently (avoid per-clone
  divergence in what "headline numbers" mean — YM already renamed
  traffic→reach, clicks→engagement).
- **One sign-off pattern.** Plan-approval share links (`plan.php`) exist; if a
  pre-publish (Push) sign-off is wanted, reuse the same pattern rather than a
  second mechanism.
- **Agency HQ ↔ Client HQ status.** Ensure Agency HQ's roster/health reflects
  live Client HQ state (the roster model has placeholder approval/health
  fields — wire them to real portal data).

---

## Suggested order

1. **Track 1 first** — productise provisioning + kill clone drift. It's the
   bottleneck on every client you add and underpins the commercial model.
2. **Track 3** in parallel where cheap (consistency/seam fixes).
3. **Track 2 (Leads Central)** when a client actually needs it / as the
   front-door product — not before Track 1 pays off.

## Cross-cutting decision that shapes all of it

**Self-serve vs DF-operated** (`docs/commercialisation-plan.md`). DF-operated
→ per-client instances are fine; Track 1 is "template + config + provisioning."
Self-serve → you need genuine multi-tenancy + billing + roles, a much bigger
Track 1. Decide this before investing heavily in Track 1's shape.
