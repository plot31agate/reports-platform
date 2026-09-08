# Client HQ → Agency HQ status contract

Agency HQ health-checks every client's website and Client HQ portal by
fetching them (`POST /agency/api/health` sweeps the whole roster). A portal
can go one step further and **publish its field state** so Agency HQ's task
engine runs on real numbers instead of anything hand-kept.

## The contract

Serve a static JSON file at the portal root:

```
<portalUrl>/agency-status.json
```

```json
{
  "pendingApprovals": 1,
  "contentDueThisWeek": 2,
  "note": "GA4 daily export 3 days stale",
  "updated": "2026-09-08T09:00:00Z"
}
```

All keys optional; unknown keys are ignored. `pendingApprovals` counts client
plan/approval share links awaiting sign-off; `contentDueThisWeek` counts
planned-but-not-drafted articles; `note` is a one-liner surfaced on the
client's page; `updated` is when the portal wrote the file.

## How each portal keeps it fresh

The Client HQ builds (Aera House pattern) regenerate this file whenever their
own state changes — e.g. the content engine writes it on publish/plan events,
or a small cron recounts and rewrites it hourly. It's public but harmless:
two counters and a note, no client data.

## What Agency HQ does with it

- Site/portal reachability → the client's health dot (401/403 counts as up —
  auth-gated is still alive; 5xx/timeouts are down).
- `pendingApprovals` / `contentDueThisWeek` → real tasks on the This-week
  board and the client page's Outstanding list.
- The whole `live` block in reporting.db is replaced on every check, so
  nothing in it can go stale silently — it is exactly what was last measured,
  stamped with `checkedAt`.
