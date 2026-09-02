"""At-a-glance strip — traffic-light status rows for the top of the report.

Each row is one area of the engagement with a status dot, a one-line
headline written from the month's numbers, and (for amber/red rows) a "next"
line saying what is being done about it. Statuses and headlines are proposed
by the month-on-month rules below; the AI drafts the next lines during
synthesis; the operator can flip any dot, rewrite any line or drop a row on
the review screen. Operator overrides live in commentary notes under
"glance", keyed by row key, and belong to their month only — row drops and
owner renames travel via the generic hidden/cells layout machinery instead.

Only rows whose source data exists render, except Leads: that row shows a
grey "setting up" state until a leads file appears, because the point of it
is to tell the client tracking is coming.
"""

STATUSES = ("green", "amber", "red", "grey")
STATUS_LABELS = {"green": "On track", "amber": "Watching", "red": "Needs action", "grey": "Setting up"}

# Month-on-month percentage thresholds: within ±STEADY is flat, below AMBER
# is a watch, below RED needs action.
STEADY = 3.0
AMBER = -3.0
RED = -15.0

OWNER_DF = "Digital Footprints"
OWNER_DEV = "Web Dev"
OWNER_BOTH = "Digital Footprints + Web Dev"


def build_glance(parsed: dict, prev_parsed: dict, technical_seo: dict | None,
                 client_config: dict) -> list:
    """Compute the default rows. Returns [] when no source has data."""
    def d(tree, key):
        return ((tree or {}).get(key) or {}).get("data")

    rows = [
        _organic(d(parsed, "search_console"), d(prev_parsed, "search_console")),
        _keywords(d(parsed, "core_keywords")),
        _users(d(parsed, "ga4_export"), d(prev_parsed, "ga4_export")),
        _geos(d(parsed, "ga4_geography"), d(prev_parsed, "ga4_geography")),
        _engagement(d(parsed, "ga4_export"), d(prev_parsed, "ga4_export")),
        _authority(technical_seo, d(parsed, "ahrefs_trends")),
        _site_health(technical_seo),
        _leads(d(parsed, "leads"), d(prev_parsed, "leads")),
    ]
    rows = [r for r in rows if r]
    # A strip that is only the grey leads placeholder says nothing — skip it.
    if all(r["status"] == "grey" for r in rows):
        return []
    return rows


def apply_glance_overrides(rows: list, overrides: dict, ai_next: dict) -> dict:
    """Resolve each row's shown status/headline/next from operator overrides
    (notes["glance"]) over AI-drafted next lines over the computed defaults.
    Defaults ride along so the review form can store only real deviations."""
    for r in rows:
        ov = (overrides or {}).get(r["key"]) or {}
        r["default_status"] = r["status"]
        r["default_headline"] = r["headline"]
        r["default_next"] = r.get("next") or (ai_next or {}).get(r["key"]) or ""
        if ov.get("status") in STATUSES:
            r["status"] = ov["status"]
        if ov.get("headline"):
            r["headline"] = ov["headline"]
        r["next"] = ov.get("next") or r["default_next"]
        r["status_label"] = STATUS_LABELS[r["status"]]
    return {"rows": rows}


def glance_tally(rows: list) -> dict:
    counts = {s: 0 for s in STATUSES}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return counts


def _row(key, area, status, headline, owner, next_line=""):
    return {"key": key, "area": area, "status": status, "headline": headline,
            "owner": owner, "next": next_line}


def _pct(cur, prev):
    if not isinstance(cur, (int, float)) or not isinstance(prev, (int, float)) or not prev:
        return None
    return (cur - prev) / abs(prev) * 100


def _trend_status(pct):
    """Status for a metric where up is good."""
    if pct is None or pct >= AMBER:
        return "green"
    return "red" if pct <= RED else "amber"


def _organic(cur, prev):
    clicks = (cur or {}).get("clicks")
    if clicks is None:
        return None
    pct = _pct(clicks, (prev or {}).get("clicks"))
    if pct is None:
        return _row("organic", "Organic traffic", "green",
                    f"{clicks:,} organic clicks this month - baseline", OWNER_DF)
    if pct >= STEADY:
        head = f"Organic clicks up {round(pct)}% month on month"
    elif pct > AMBER:
        head = "Organic clicks steady month on month"
    else:
        head = f"Organic clicks down {abs(round(pct))}% month on month"
    return _row("organic", "Organic traffic", _trend_status(pct), head, OWNER_DF)


def _keywords(kw):
    if not kw or not kw.get("tracked"):
        return None
    tracked, ranked = kw["tracked"], kw.get("ranked") or 0
    improved, declined = kw.get("improved") or 0, kw.get("declined") or 0
    top3, top10 = kw.get("top3") or 0, kw.get("top10") or 0
    if declined >= max(3, ranked / 2) and declined > improved:
        status = "red"
        head = f"{declined} of {tracked} keywords dropped this month"
    elif declined > improved:
        status = "amber"
        head = f"{declined} keywords slipped, {improved} improved"
    else:
        status = "green"
        if top10:
            head = f"{top10} of {tracked} keywords in the top 10"
            if top3:
                head += f", {top3} in the top 3"
        elif improved:
            head = f"{improved} keywords improved position this month"
        else:
            head = f"{tracked} keywords tracked, positions holding"
    return _row("keywords", "Keyword rankings", status, head, OWNER_DF)


def _users(cur, prev):
    users = (cur or {}).get("users")
    if not users:
        return None
    prev_users = (prev or {}).get("users")
    pct = _pct(users, prev_users)
    if pct is None:
        return _row("users", "User activity", "green",
                    f"{users:,} users this month - baseline", OWNER_DF)
    if pct >= STEADY:
        head = f"Users up {round(pct)}% month on month ({users:,})"
    elif pct > AMBER:
        head = f"User numbers steady at {users:,}"
    else:
        head = f"Users down {abs(users - prev_users):,} month on month"
    return _row("users", "User activity", _trend_status(pct), head, OWNER_DF)


def _engagement(cur, prev):
    secs = (cur or {}).get("avg_engagement_secs")
    if not secs:
        return None
    prev_secs = (prev or {}).get("avg_engagement_secs")
    pct = _pct(secs, prev_secs)
    if pct is None:
        return _row("engagement", "Engagement", "green",
                    f"Average engagement time {_dur(secs)} - baseline", OWNER_BOTH)
    delta = int(round(abs(secs - prev_secs)))
    if pct >= STEADY:
        head = f"Average engagement time up {delta}s to {_dur(secs)}"
    elif pct > AMBER:
        head = f"Average engagement time steady at {_dur(secs)}"
    else:
        head = f"Average engagement time down {delta}s to {_dur(secs)}"
    # Engagement dipping is a watch, never a red on its own.
    return _row("engagement", "Engagement", "green" if pct > AMBER else "amber", head, OWNER_BOTH)


def _geos(cur, prev):
    countries = (cur or {}).get("top_countries") or []
    total = (cur or {}).get("total_visits")
    if not countries or not total:
        return None

    def visits(geo, total_v):
        return {c["country"]: c["share"] / 100 * total_v for c in (geo or {}).get("top_countries") or []}

    cur_v = visits(cur, total)
    prev_total = (prev or {}).get("total_visits")
    prev_v = visits(prev, prev_total) if prev_total else {}
    both = [c for c in cur_v if c in prev_v]
    if not both:
        top = countries[0]
        return _row("geos", "Geos", "green",
                    f"Top market {top['country']} at {top['share']}% of visits - baseline", OWNER_DF)

    def p(c):
        return _pct(cur_v[c], prev_v[c]) or 0

    up = sorted((c for c in both if p(c) >= STEADY), key=lambda c: -p(c))
    down = sorted((c for c in both if p(c) <= AMBER), key=lambda c: p(c))
    if up and not down:
        status, head = "green", f"Growth across {_names(up)}"
    elif up and down:
        status, head = "amber", f"{_names(up)} growing; {_names(down)} dipped"
    elif down:
        status = "red" if len(down) > len(both) / 2 else "amber"
        head = f"Visits down across {_names(down)}"
    else:
        status, head = "green", "Visitor mix steady across markets"
    return _row("geos", "Geos", status, head, OWNER_DF)


def _names(countries, limit=2):
    names = countries[:limit]
    extra = len(countries) - len(names)
    joined = " and ".join(names) if len(names) <= 2 else ", ".join(names)
    return f"{joined} and {extra} more" if extra > 0 else joined


def _authority(technical_seo, trends):
    dr, delta = None, None
    if technical_seo and technical_seo.get("current"):
        dr = technical_seo["current"].get("domain_rating")
        delta = technical_seo.get("dr_delta")
    if dr is None and trends:
        dr = (trends.get("latest") or {}).get("domain_rating")
        delta = (trends.get("deltas") or {}).get("domain_rating")
    if dr is None:
        return None
    if delta is None:
        return _row("authority", "Domain rating", "green", f"Domain rating {dr} - baseline", OWNER_DF)
    if delta > 0:
        return _row("authority", "Domain rating", "green",
                    f"Domain rating up {round(delta)} to {dr}", OWNER_DF)
    if delta == 0:
        return _row("authority", "Domain rating", "green", f"Domain rating steady at {dr}", OWNER_DF)
    status = "red" if delta <= -3 else "amber"
    return _row("authority", "Domain rating", status,
                f"Domain rating down {abs(round(delta))} to {dr}", OWNER_DF)


def _site_health(technical_seo):
    if not technical_seo or not technical_seo.get("current"):
        return None
    cur = technical_seo["current"]
    score = cur.get("health_score")
    high = cur.get("high_open") or 0
    if high:
        return _row("site_health", "Site health", "red",
                    f"{high} high-severity finding{'s' if high != 1 else ''} open", OWNER_DEV)
    delta = technical_seo.get("health_delta")
    if delta is not None and delta < 0:
        return _row("site_health", "Site health", "amber",
                    f"Site health down {abs(delta)} to {score}/100", OWNER_DEV)
    head = f"Site health {score}/100"
    if not technical_seo.get("register_missing"):
        head += ", no high-severity findings open"
    return _row("site_health", "Site health", "green", head, OWNER_DEV)


def _leads(cur, prev):
    total = (cur or {}).get("total")
    if total is None:
        return _row("leads", "Leads", "grey",
                    "Lead tracking being added to the site", OWNER_DEV)
    pct = _pct(total, (prev or {}).get("total"))
    if pct is None:
        return _row("leads", "Leads", "green",
                    f"{total:,} lead{'s' if total != 1 else ''} - first month of tracking", OWNER_DEV)
    if pct >= STEADY:
        head = f"Leads up {round(pct)}% month on month ({total:,})"
    elif pct > AMBER:
        head = f"Leads steady at {total:,}"
    else:
        head = f"Leads down {abs(round(pct))}% month on month ({total:,})"
    return _row("leads", "Leads", _trend_status(pct), head, OWNER_DEV)


def _dur(secs):
    secs = int(secs)
    return f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60:02d}s"
