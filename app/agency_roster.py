"""Agency roster seed — the metadata Agency HQ needs that the reporting core
doesn't otherwise track: who leads a client, its delivery cadence, its strategy
plan, its portal, and the field brands that live only in the front end.

The DB is the single source of truth at runtime. This module is seed data:
init_db() ensures every client here exists in the `clients` table with an
`agency` block in its config_json, without overwriting one that's already there
(operator edits in Agency HQ win). The reporting-core clients (sportingtech,
northwind-gaming, ym-predictions) already exist as rows — they just gain the
agency block. The Client HQ brands (Aera House, Vivo, Mindway) aren't in the
core, so this is what creates them as real rows, unifying the roster.

Mirror of agency/src/lib/roster.ts — kept here so the backend owns the roster
and the front end reads it from the snapshot rather than a baked config.
"""

# slug -> (display_name, agency block)
AGENCY_ROSTER = {
    "aera-house": {
        "display_name": "Aera House",
        "agency": {
            "kind": "client-hq",
            "owner": "Steve",
            "website": "https://theaerahouse.com",
            "cadence": {"report": "monthly", "articlesPerWeek": 1, "reviewMonths": 3},
            "strategy": {"updated": "2026-08-14", "focus": "Local authority + interiors content, grow branded search"},
            "live": {"siteHealth": "ok", "pendingApprovals": 0, "contentDueThisWeek": 1},
            "portalUrl": "https://theaerahouse.com/portal/",
            "portalStatus": "live",
        },
    },
    "vivo": {
        "display_name": "Vivo",
        "agency": {
            "kind": "client-hq",
            "owner": "Steve",
            "website": "",
            "cadence": {"report": "monthly", "articlesPerWeek": 1, "reviewMonths": 3},
            "strategy": {"updated": "2026-07-30", "focus": "At-a-glance leads narrative; lift qualified enquiries"},
            "live": {"siteHealth": "ok", "pendingApprovals": 1, "contentDueThisWeek": 0},
            "portalStatus": "planned",
        },
    },
    "mindway": {
        "display_name": "Mindway",
        "agency": {
            "kind": "client-hq",
            "owner": "Steve",
            "website": "",
            "cadence": {"report": "monthly", "articlesPerWeek": 2, "reviewMonths": 3},
            "strategy": {"updated": "2026-05-02", "focus": "Daily-trends story; consolidate top landing pages"},
            "live": {"siteHealth": "warn", "pendingApprovals": 0, "contentDueThisWeek": 2, "note": "GA4 daily export 6 days stale"},
            "portalStatus": "planned",
        },
    },
    "sportingtech": {
        "display_name": "Sportingtech",
        "agency": {
            "kind": "reporting",
            "owner": "Steve",
            "website": "",
            "cadence": {"report": "monthly", "articlesPerWeek": 0, "reviewMonths": 6},
            "strategy": {"updated": "2026-06-20", "focus": "Winning Edge messaging; B2B expansion keywords"},
        },
    },
    "northwind-gaming": {
        "display_name": "Northwind Gaming",
        "agency": {
            "kind": "reporting",
            "owner": "Steve",
            "website": "",
            "cadence": {"report": "monthly", "articlesPerWeek": 0, "reviewMonths": 6},
            "strategy": {"updated": None, "focus": None},
        },
    },
    "ym-predictions": {
        "display_name": "YM Predictions",
        "agency": {
            "kind": "reporting",
            "owner": "Steve",
            "website": "",
            "cadence": {"report": "monthly", "articlesPerWeek": 0, "reviewMonths": 6},
            "strategy": {"updated": None, "focus": None},
        },
    },
}


# The default agency block for a brand-new client created from Agency HQ.
def default_agency_block(kind: str = "reporting", owner: str = "Unassigned") -> dict:
    return {
        "kind": kind,
        "owner": owner,
        "website": "",
        "cadence": {
            "report": "monthly" if kind == "reporting" else "monthly",
            "articlesPerWeek": 0,
            "reviewMonths": 6,
        },
        "strategy": {"updated": None, "focus": None},
        "live": {},
        "portalStatus": "none" if kind == "client-hq" else None,
    }
