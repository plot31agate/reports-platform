# Platform Blueprint — What We're Building

Transcribed and organised from the original notebook sketches (5 pages).
This is the product/process spec: the thing we're actually building, kept in
one place. Where the notes were uncertain the "(?)" is preserved; build hints
(functions to reuse, flexibility needs) are kept as written.

Companion docs: `docs/sales-brief.md` (how we describe it),
`docs/commercialisation-plan.md` (how we sell it).

---

## The core idea: one monthly operating rhythm

The platform runs a client's whole marketing month as a single loop. Client
HQ is the front door; the work moves through four stages across the month:

```
                ┌─────────────┐
                │  CLIENT HQ   │  ← entry / dashboard
                └──────┬──────┘
                       │
  START OF MONTH   →   PLAN     (Planner: strategy, news feed / ideas board, calendar)
  IN MONTH         →   MAKE     (Studio: creative, social, content)
  IN MONTH         →   PUSH     (schedule, push to live)
  END OF MONTH     →   REPORT   (reporting module)
                       │
                (feeds next month's PLAN)

  LEADS CENTRAL — WordPress plugin, runs alongside (leads → reporting)
```

The loop is deliberate: the end-of-month Report feeds the start-of-month
Plan, so strategy is always built from what actually happened.

---

## Client HQ — the front door

- Needs a **walkthrough on first load / setup**.
- **Opening screen = a stepped form** (client setup). This step **can be
  deferred** (doesn't have to block first use).
- **Dashboard HQ** once set up:
  - Report stats
  - "This week needs" (what's due / needs action this week)

## Plan — start of month

Client setup here **needs more flexibility**.

**Strategy**
- **Review reports' results & actions** — what worked, measured against
  results.
- **Suggested strategy to accommodate** — proposes ~3 things (accept / reject,
  ✗ / ✓), each with an **outcome + tactics**; **reviews client notes / setup**
  to inform it.
- **"Plan Month" function** — calendar display.
  - Export calendar function
  - Drag + drop on the calendar
  - Reminder pings (?)
- **Share plan function** for client **sign-off** (calendar view).

## Make — in month

Two areas: **Studio** (production) and **Content** (ideation → draft).

**Studio**
- Upload templates *(functions)*
- Use plans I set up *(functions)*
- Reels etc. (make this better)
- **Calendar view** — "you need …" list you **tick off**, which **adds to the
  social queue**.

**Content**
- "You need …" (what's required)
- What are you creating
- Idea board
- Draft button
- Review
- SEO
- Image add

## Push — in month

*(labelled "SEND" in the notes)*
- **Push to Buffer** — reuse the **current scheduler**.
- **Client sign-off** (?) before publishing.
- (third route sketched, not yet defined)
- Sub-steps: **Schedule** → **Push to live**.

## Report — end of month

- Keep it **as is, but with better flow**.
- **Define report type** — internal report vs client report ("we …").
- **Better links to strategy** and the **"why" on recommended actions**
  (so actions tie back to the plan and the results).
- (room to extend — "+")

## Leads Central — WordPress plugin (runs alongside)

A plugin on the client's own WordPress site; feeds lead data back into
reporting.

- Monitor leads
- Score leads
- Manage follow-ups
- Automate email follow-ups
- **CRM (?)** — connect to the client's current CRM
- Secure login
- Reporting for sales [tracking]
- Tracking for acquisition
- Snapshot analysis (?)

---

## Cross-cutting notes & open questions (from the sketches)

- **First-load walkthrough** needed across setup (Client HQ), not just a wall
  of forms — stepped, deferrable.
- **Flexibility** in client setup (flagged on the Plan page) — the setup model
  needs to bend per client.
- **Reuse existing functions** where noted: the Buffer scheduler (Push), and
  template / plan-setup functions (Studio).
- **Sign-off appears twice** — plan sign-off (Plan, calendar view) and pre-
  publish sign-off (Push). Worth a single, consistent sign-off pattern.
- Items marked **(?)** are unconfirmed intent, not commitments: CRM connect,
  reminder pings, snapshot analysis, the pre-publish sign-off gate, and the
  third Push route.
- The **report → plan loop** is the backbone: recommended actions and the
  "why" must carry from Report into next month's Plan.
