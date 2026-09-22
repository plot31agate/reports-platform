# Build Backlog — the client-facing monthly loop

Turns `docs/platform-blueprint.md` into ordered, buildable work, grounded in
what's actually in the repo (`docs/reconciliation.md`). Scope: build the
client-facing loop on top of the live reporting core.

**Assumes this repo is the build target.** If the loop is already built in
another repo, stop and redo the reconciliation first.

How to use this: build **thin vertical slices**, one module at a time, each
working end-to-end for one real client before widening. Reuse the foundations
named per module. Items marked **(?)** are decisions to make, not tasks to do.

---

## Suggested order (and why)

The Report module is already live, so build the rest of the loop back toward
it, reusing existing foundations first:

0. **Walking skeleton** — prove the loop end-to-end, thinnest possible.
1. **Client HQ dashboard** — surfaces what already exists; fastest visible value.
2. **Plan** — closes the Report → Plan backbone; reuses Strategy tracking.
3. **Make** (Studio + Content) — the largest build.
4. **Push** — depends on Make (a queue to push) and Plan (a calendar).
5. **Leads Central** — parallel track (different stack); feeds Report.

---

## 0. Walking skeleton (do this first)

**Goal:** one real client moves a single item through Plan → Make → Push →
Report in the app, however crudely, so the data model and module seams are
proven before feature depth.

**Done when:** for one client you can create a plan item, attach a piece of
content to it, mark it pushed, and see it referenced in that period's report —
even if every screen is bare.

**Why:** de-risks the shared data model (client → period → plan item →
content → push → report linkage) that all four modules depend on.

---

## 1. Client HQ dashboard

**Goal:** a client-facing front door — report stats + "this week needs" —
distinct from the Agency HQ (internal) console.

**Reuse:** client portal (`app/templates/portal/*`, `/portal/*`) for auth +
shell; Agency HQ task engine (`agency/src/views/ThisWeek.tsx`,
`agency/src/lib/agency.ts`) for the "this week needs" logic.

**Thin slice:** logged-in client sees latest report stats + a "this week"
list, pulled from existing data.

**Acceptance criteria:**
- A portal-authenticated client sees a dashboard (not just the report list).
- Shows headline report stats for the current period.
- Shows "this week needs" derived from real state (due items / approvals).
- First-load walkthrough and stepped setup form exist but are **deferrable**
  (per the blueprint) — ship the dashboard first, walkthrough second.

**(?) decisions:** how much of the Agency HQ task logic is client-safe to
expose; what "this week needs" means to a client vs to DF.

## 2. Plan (start of month)

**Goal:** build next month from last month's results, on a calendar, shareable
for sign-off.

**Reuse:** Report synthesis already outputs recommended actions + the "why"
(`app/reports/*`) — Plan consumes them. Strategy tracking (`Strategy.tsx`) as
a starting UI.

**Thin slice:** show last report's recommended actions; let the operator
accept/reject ~3 into a plan for the period.

**Acceptance criteria:**
- Pulls the previous report's results + recommended actions into a review.
- Suggested strategy = ~3 items, each accept/reject (✗/✓) with an
  outcome + tactics; informed by client notes/setup.
- "Plan Month" calendar view of accepted items.
- Calendar supports drag-and-drop and export.
- A shareable plan view a client can sign off (calendar view).
- Client setup here is **flexible** (flagged in the blueprint) — setup model
  must bend per client, not a fixed form.

**(?) decisions:** reminder pings (channel? timing?); one shared sign-off
pattern across Plan and Push (see below).

## 3. Make — Studio + Content

**Goal:** produce the month's content, from idea to review-ready, feeding a
social queue.

**Reuse:** none directly — this is new. Keep the data model aligned with Plan
(a plan item → one or more content pieces) and Push (a piece → a queue entry).

### 3a. Studio
- Upload templates (reusable) and reuse a saved plan setup.
- Reels / short-form support.
- Calendar view = a "you need…" checklist you tick off; ticking adds the item
  to the social queue.

**Acceptance:** a piece can be produced from a template and, when ticked on
the calendar, appears in the social queue.

### 3b. Content
- Ideas board → "what are you creating" flow.
- Draft → Review workflow.
- SEO check and image add.

**Acceptance:** an idea moves ideas-board → draft → review; SEO + image
attach; a reviewed piece is available to Push.

**(?) decisions:** template format/storage; where images live; SEO check depth
(heuristic vs API); reels tooling.

## 4. Push (schedule + publish)

**Goal:** get approved content live via the client's scheduler, with optional
sign-off.

**Reuse:** none built — **there is no Buffer integration today** (the
blueprint's "current scheduler" does not exist in this repo). This is a new
integration.

**Thin slice:** connect one Buffer account; push one queued item to it.

**Acceptance criteria:**
- Buffer account connects (OAuth/token) per client.
- A social-queue item can be scheduled and pushed to Buffer.
- Schedule → push-to-live states are visible.
- Optional pre-publish **client sign-off gate** before anything publishes.

**(?) decisions:** confirm Buffer is the target (vs another scheduler); the
third Push route sketched in the notebook (undefined); unify the sign-off
pattern with Plan's sign-off.

## 5. Leads Central (parallel track)

**Goal:** a WordPress plugin on the client's site that captures, scores and
chases leads, and feeds the numbers back into the Report.

**Reuse:** the leads CSV path already feeds the report at-a-glance
(`app/ingestion/parsers/leads.py`) — Leads Central would replace the manual
CSV with a live feed. **The plugin itself does not exist** and is a different
stack (PHP/WordPress) — treat as a separate track/repo.

**Acceptance criteria (v1):**
- Plugin installs on a WordPress site with secure login.
- Monitors + scores incoming leads; manages follow-ups; automated email
  follow-up sequences.
- Reporting for sales tracking + acquisition tracking.
- Feeds lead data back into the platform's reporting.

**(?) decisions:** CRM connect (which CRMs?); snapshot analysis scope;
build vs adapt an existing WP lead framework.

---

## Cross-cutting, decide once (affects several modules)

- **Shared data model:** client → period → plan item → content piece → push →
  report linkage. Nail this in the walking skeleton.
- **One sign-off pattern** used by both Plan (plan sign-off) and Push
  (pre-publish sign-off).
- **Client HQ vs Agency HQ boundary:** what's client-facing vs DF-internal.
- **Self-serve vs DF-operated** (from `docs/commercialisation-plan.md`) —
  changes auth, roles, and how setup/onboarding work across every module.
