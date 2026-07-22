"""Ahrefs API v3 connector.

Feeds:
  ahrefs_backlinks       — CSV shaped like the Ahrefs UI backlinks export
                           ("Referring page URL", "Domain rating", ...).
  technical_seo_metrics  — monthly health score / DR / open-issue counts from
                           Site Audit + Site Explorer, appended to the running
                           history so month-over-month deltas keep working.

The curated issue register (technical_seo_register) stays a manual upload:
it carries the agency's judgement (status, recommendation, owner), which an
API can't supply.
"""
import csv as _csv
import json as _json
import re
from datetime import date

from app.connectors._util import ConnectorError, period_range, write_csv

API = "https://api.ahrefs.com/v3"
TIMEOUT = 30


def _requests():
    # Lazy import so a VPS that hasn't installed new deps yet still boots -
    # the connector fails with a clear message instead of crashing the app.
    try:
        import requests
        return requests
    except ImportError:
        raise ConnectorError("The 'requests' package is not installed - run pip install -r requirements.txt")


def _headers(config):
    key = (config.get("api_key") or "").strip()
    if not key:
        raise ConnectorError("No API key saved")
    return {"Authorization": f"Bearer {key}", "Accept": "application/json"}


def _target(config):
    target = (config.get("target") or "").strip()
    if not target:
        raise ConnectorError("No target domain saved")
    return target


def _post(config, path, body):
    requests = _requests()
    try:
        resp = requests.post(f"{API}{path}", headers=_headers(config), json=body, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise ConnectorError(f"Could not reach Ahrefs: {e}")
    if resp.status_code == 401:
        raise ConnectorError("Ahrefs rejected the API key (401) - check it and that API v3 access is enabled")
    if resp.status_code == 403:
        raise ConnectorError("Ahrefs key lacks access to this endpoint (403) - check your plan's API rows")
    if resp.status_code != 200:
        raise ConnectorError(f"Ahrefs error {resp.status_code}: {resp.text[:150]}")
    return resp.json()


def _get(config, path, params):
    requests = _requests()
    try:
        resp = requests.get(f"{API}{path}", headers=_headers(config), params=params, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise ConnectorError(f"Could not reach Ahrefs: {e}")
    if resp.status_code == 401:
        raise ConnectorError("Ahrefs rejected the API key (401) - check it and that API v3 access is enabled")
    if resp.status_code == 403:
        raise ConnectorError("Ahrefs key lacks access to this endpoint (403) - check your plan's API rows")
    if resp.status_code != 200:
        raise ConnectorError(f"Ahrefs error {resp.status_code}: {resp.text[:150]}")
    return resp.json()


def test_key(config) -> tuple[bool, str]:
    """Validate the agency API key alone, against a known domain."""
    try:
        _get(config, "/site-explorer/domain-rating", {
            "target": "ahrefs.com",
            "date": date.today().isoformat(),
        })
        return True, "API key works"
    except ConnectorError as e:
        return False, str(e)


def test(config) -> tuple[bool, str]:
    try:
        data = _get(config, "/site-explorer/domain-rating", {
            "target": _target(config),
            "date": date.today().isoformat(),
        })
        dr = (data.get("domain_rating") or {}).get("domain_rating")
        return True, f"Connected - {_target(config)} has DR {dr}"
    except ConnectorError as e:
        return False, str(e)


def sync(config, source_key, dest, period):
    if source_key == "ahrefs_backlinks":
        data = _get(config, "/site-explorer/all-backlinks", {
            "target": _target(config),
            "select": "url_from,domain_rating_source,url_to,anchor,first_seen",
            "mode": "subdomains",
            "history": "live",
            "limit": 5000,
        })
        rows = data.get("backlinks") or []
        write_backlinks_csv(rows, dest)
        return len(rows)

    if source_key == "technical_seo_metrics":
        return _sync_technical_seo(config, dest, period)

    if source_key == "search_console":
        return _sync_gsc(config, dest, period)

    if source_key == "ahrefs_trends":
        return _sync_trends(config, dest, period)

    if source_key == "core_keywords":
        return _sync_core_keywords(config, dest, period)

    if source_key == "competitor_benchmark":
        return _sync_competitors(config, dest, period)

    raise ConnectorError(f"Ahrefs connector can't feed {source_key}")


# ---------- competitor benchmark / share of voice ----------

BENCH_COLS = ["month", "is_client", "brand", "domain", "domain_rating",
              "referring_domains", "organic_traffic"]


def _normalise_domain(d: str) -> str:
    d = d.strip().lower().replace("https://", "").replace("http://", "").strip("/")
    return d[4:] if d.startswith("www.") else d


def _project_id(config) -> str:
    # gsc_project_id kept as a fallback for configs saved before the two
    # project-ID fields were merged into audit_project_id.
    return (config.get("audit_project_id") or "").strip() or (config.get("gsc_project_id") or "").strip()


def _sync_competitors(config, dest, period):
    target = _target(config)
    raw = config.get("competitor_domains") or ""
    domains = [d for d in (_normalise_domain(p) for p in re.split(r"[\n,]+", raw)) if d]
    if not domains:
        domains = _project_competitors(config)
    if not domains:
        raise ConnectorError(
            "No competitors found - set the Ahrefs project ID (to pull the project's list) "
            "or fill in competitor domains on this client's Ahrefs card"
        )

    all_urls = [target] + domains
    body = {
        "select": ["url", "domain_rating", "refdomains", "org_traffic"],
        "targets": [{"url": u, "mode": "subdomains", "protocol": "both"} for u in all_urls],
    }
    data = _post(config, "/batch-analysis/batch-analysis", body)
    results = data.get("targets") or []
    if not results:
        raise ConnectorError("Ahrefs batch analysis returned no results")

    # Results echo the url; map back to our ordered list to keep client first.
    by_url = {_normalise_domain(r.get("url") or ""): r for r in results}

    names = config.get("competitor_names") or []

    def pretty(domain, is_client):
        if is_client:
            return config.get("client_display_name") or domain
        squashed = domain.replace("-", "").replace(".", "")
        for n in names:
            if n.lower().replace(" ", "").replace("-", "") in squashed:
                return n
        return domain.split(".")[0].capitalize()

    rows = []
    for i, u in enumerate(all_urls):
        r = by_url.get(u)
        if not r:
            continue
        rows.append({
            "month": period,
            "is_client": 1 if i == 0 else 0,
            "brand": pretty(u, i == 0),
            "domain": u,
            "domain_rating": round(float(r.get("domain_rating") or 0), 1),
            "referring_domains": int(r.get("refdomains") or 0),
            "organic_traffic": int(r.get("org_traffic") or 0),
        })
    if not rows:
        raise ConnectorError("Could not match any batch analysis results back to the requested domains")

    # Carry forward prior months so share-of-voice trends build up over time.
    history = _bench_history(dest, period)
    out = history + [[r[c] for c in BENCH_COLS] for r in rows]
    write_csv(dest, BENCH_COLS, out)
    return len(rows)


def _project_competitors(config) -> list:
    """Competitor domains from the Ahrefs project's Rank Tracker list."""
    project_id = _project_id(config)
    if not project_id:
        return []
    try:
        data = _get(config, "/management/project-competitors", {"project_id": project_id})
    except ConnectorError as e:
        raise ConnectorError(
            f"Could not pull the project's competitor list ({e}) - "
            "fill in competitor domains manually on this client's Ahrefs card"
        )
    target = _normalise_domain(_target(config))
    domains = []
    for c in data.get("competitors") or []:
        d = _normalise_domain(c.get("url") or "")
        d = d.split("/")[0]  # prefix/exact modes carry a path
        if d and d != target and d not in domains:
            domains.append(d)
    return domains


def _bench_history(dest, period) -> list:
    rows = []
    data_root = dest.parent.parent
    if not data_root.exists():
        return rows
    seen_months = set()
    for path in sorted(data_root.glob("*/competitor_benchmark*.csv")):
        try:
            with open(path, newline="", encoding="utf-8") as f:
                for r in _csv.DictReader(f):
                    month = (r.get("month") or "").strip()
                    if month and month != period and (month, r.get("domain")) not in seen_months:
                        seen_months.add((month, r.get("domain")))
                        rows.append([(r.get(c) or "").strip() for c in BENCH_COLS])
        except OSError:
            continue
    rows.sort(key=lambda r: r[0])
    return rows


# ---------- Search Console via GSC Insights (free API calls) ----------

def _sync_gsc(config, dest, period):
    project_id = _project_id(config)
    if not project_id:
        raise ConnectorError("No Ahrefs project ID saved")
    start, end = period_range(period)
    data = _get(config, "/gsc/keywords", {
        "project_id": project_id,
        "date_from": start,
        "date_to": end,
        "limit": 1000,
    })
    rows = data.get("keywords") or []
    if not rows:
        raise ConnectorError(
            f"Ahrefs returned no GSC keywords for {period} - check the project has Search Console connected"
        )
    write_gsc_keywords_csv(rows, dest)
    return len(rows)


def write_gsc_keywords_csv(rows, dest):
    """GSC Insights rows -> Queries-export-shaped CSV for parse_search_console.

    CTR is recomputed from clicks/impressions so we never depend on whether
    the API reports it as a fraction or a percentage.
    """
    header = ["Top queries", "Clicks", "Impressions", "CTR", "Position"]
    out = []
    for r in rows:
        clicks = int(r.get("clicks") or 0)
        impressions = int(r.get("impressions") or 0)
        ctr = round(clicks / impressions * 100, 2) if impressions else 0.0
        out.append([
            r.get("keyword", ""),
            clicks,
            impressions,
            f"{ctr}%",
            round(float(r.get("position") or 0), 1),
        ])
    write_csv(dest, header, out)


# ---------- core keyword rankings (Site Explorer organic keywords) ----------

CORE_KEYWORD_COLS = ["keyword", "location", "volume", "position", "position_prev"]

# How many keywords to report when the client has no core list of their own.
TOP_KEYWORD_FALLBACK = 25


def _core_keyword_list(config) -> list:
    raw = config.get("core_keywords") or ""
    return [k.strip() for k in re.split(r"[\n,]+", raw) if k.strip()]


def _sync_core_keywords(config, dest, period):
    """Organic positions for the client's core keywords, from Site Explorer.

    Site Explorer rather than Rank Tracker: it covers every keyword the domain
    ranks for without anyone having to add them to a project first, and it
    costs no tracked-keyword slots. The trade is that a keyword the client
    does not rank for at all comes back empty - which is the honest answer,
    and lands in the CSV as an unranked row.

    One call carries both months: `date` is the period end, `date_compared`
    the previous month end, so this month's position and last month's arrive
    side by side.
    """
    target = _target(config)
    _start, end = period_range(period)
    prev_at = _previous_month_end(period)
    wanted = _core_keyword_list(config)

    select = ["keyword", "keyword_country", "volume", "best_position"]
    params = {
        "target": target,
        "mode": "subdomains",
        "protocol": "both",
        "date": end,
        "order_by": "volume:desc",
        "limit": 1000 if wanted else TOP_KEYWORD_FALLBACK,
    }
    country = (config.get("keyword_country") or "").strip().upper()
    if country:
        params["country"] = country
    if prev_at:
        params["date_compared"] = prev_at[:10]
        select.append("best_position_prev")
    params["select"] = ",".join(select)
    if wanted:
        # Filter server-side: Ahrefs bills per row returned, and a domain can
        # rank for thousands of keywords we are not reporting on.
        params["where"] = _json.dumps(
            {"or": [{"field": "keyword", "is": ["eq", k.lower()]} for k in wanted]}
        )

    rows = _get(config, "/site-explorer/organic-keywords", params).get("keywords") or []

    # Without a country filter the same keyword comes back once per market it
    # ranks in, so keep the strongest showing and report the market with it.
    best = {}
    for r in rows:
        key = (r.get("keyword") or "").strip().lower()
        if not key:
            continue
        held = best.get(key)
        if held is None or _better_position(r.get("best_position"), held.get("best_position")):
            best[key] = r

    if wanted:
        ordered = [best.get(k.lower()) or {"keyword": k} for k in wanted]
    else:
        ordered = sorted(best.values(), key=lambda r: -(r.get("volume") or 0))
        if not ordered:
            raise ConnectorError(
                f"Ahrefs found no organic keywords for {target} in {period} - "
                "check the target domain, or set this client's core keywords"
            )

    out = [[r.get("keyword", ""), r.get("keyword_country", ""), r.get("volume", ""),
            r.get("best_position", ""), r.get("best_position_prev", "")] for r in ordered]
    write_csv(dest, CORE_KEYWORD_COLS, out)
    return len(out)


def _better_position(candidate, held) -> bool:
    """True when `candidate` is a higher ranking than `held` (1 beats 9, and
    any ranking beats none)."""
    if candidate is None:
        return False
    return held is None or candidate < held


# ---------- 12-month authority trends ----------

def _sync_trends(config, dest, period):
    target = _target(config)
    _start, end = period_range(period)
    try:
        year, month = int(period[:4]), int(period[5:7])
    except ValueError:
        raise ConnectorError(f"Period must be YYYY-MM, got {period}")
    from_month = month - 11
    from_year = year + (from_month - 1) // 12
    from_month = ((from_month - 1) % 12) + 1
    date_from = f"{from_year:04d}-{from_month:02d}-01"
    span = {"target": target, "date_from": date_from, "date_to": end, "history_grouping": "monthly"}

    dr_rows = _get(config, "/site-explorer/domain-rating-history", span).get("domain_ratings") or []
    rd_rows = _get(config, "/site-explorer/refdomains-history", span).get("refdomains") or []
    mt_rows = _get(config, "/site-explorer/metrics-history",
                   {**span, "select": "date,org_traffic"}).get("metrics") or []

    months: dict = {}
    for r in dr_rows:
        months.setdefault(r["date"][:7], {})["domain_rating"] = round(float(r.get("domain_rating") or 0), 1)
    for r in rd_rows:
        months.setdefault(r["date"][:7], {})["referring_domains"] = int(r.get("refdomains") or 0)
    for r in mt_rows:
        months.setdefault(r["date"][:7], {})["organic_traffic"] = int(r.get("org_traffic") or 0)

    if not months:
        raise ConnectorError(f"Ahrefs returned no history for {target}")

    # Ahrefs dates each monthly history point to the first of the month, so the
    # reporting month's DR would be its value on day one - six points adrift of
    # the DR the Site Audit sync records for the same month, and of what the
    # client sees in Ahrefs. Overwrite the last point with the period-end
    # reading from the same endpoint technical SEO uses, so one report never
    # shows two domain ratings.
    if period in months:
        dr_data = _get(config, "/site-explorer/domain-rating", {"target": target, "date": end})
        dr_now = (dr_data.get("domain_rating") or {}).get("domain_rating")
        if dr_now is not None:
            months[period]["domain_rating"] = round(float(dr_now), 1)

    header = ["month", "domain_rating", "referring_domains", "organic_traffic"]
    out = [[m,
            months[m].get("domain_rating", ""),
            months[m].get("referring_domains", ""),
            months[m].get("organic_traffic", "")]
           for m in sorted(months)]
    write_csv(dest, header, out)
    return len(out)


# ---------- technical SEO metrics (Site Audit + domain rating) ----------

METRIC_COLS = [
    "month", "health_score", "high_open", "medium_open", "low_open",
    "total_open", "confirmed", "verify", "action",
    "resolved_this_month", "new_this_month", "domain_rating", "note",
]


def _sync_technical_seo(config, dest, period):
    project_id = (config.get("audit_project_id") or "").strip()
    if not project_id:
        raise ConnectorError("No Site Audit project ID saved - it's the number in the Ahrefs Site Audit URL")

    _start, end = period_range(period)
    at = f"{end}T23:59:59"

    # Health score from the last crawl finished within the period
    proj = _get(config, "/site-audit/projects", {"project_id": project_id, "date": at})
    scores = proj.get("healthscores") or []
    if not scores or scores[0].get("health_score") is None:
        raise ConnectorError(f"No finished Site Audit crawl found for {period} - run a crawl in Ahrefs first")
    health = int(scores[0]["health_score"])
    crawl_date = (scores[0].get("date") or "")[:10]

    # Issue counts by importance, compared against the previous month's crawl
    prev_at = _previous_month_end(period)
    params = {"project_id": project_id, "date": at}
    if prev_at:
        params["date_compared"] = prev_at
    issues = (_get(config, "/site-audit/issues", params)).get("issues") or []

    open_issues = [i for i in issues if (i.get("crawled") or 0) > 0]
    by = lambda imp: sum(1 for i in open_issues if i.get("importance") == imp)
    high, medium, low = by("Error"), by("Warning"), by("Notice")
    total_open = len(open_issues)
    resolved = sum(1 for i in issues if (i.get("crawled") or 0) == 0 and (i.get("removed") or 0) > 0)
    new = sum(1 for i in open_issues if i.get("change") is not None and i.get("change") == i.get("crawled"))

    # Domain rating from Site Explorer
    dr_data = _get(config, "/site-explorer/domain-rating", {"target": _target(config), "date": end})
    dr = int(round((dr_data.get("domain_rating") or {}).get("domain_rating") or 0))

    row = {
        "month": period,
        "health_score": health,
        "high_open": high, "medium_open": medium, "low_open": low,
        "total_open": total_open,
        # Crawler-verified findings land as confirmed; the verify/action
        # workflow lives in the hand-curated register, not the API.
        "confirmed": total_open, "verify": 0, "action": 0,
        "resolved_this_month": resolved,
        "new_this_month": new,
        "domain_rating": dr,
        "note": f"Synced from Ahrefs Site Audit (crawl {crawl_date})",
    }

    history = _metric_history(dest, period)
    history[period] = row
    ordered = [history[m] for m in sorted(history)]
    write_csv(dest, METRIC_COLS, [[r.get(c, "") for c in METRIC_COLS] for r in ordered])
    return total_open


def _previous_month_end(period: str):
    try:
        year, month = int(period[:4]), int(period[5:7])
    except ValueError:
        return None
    year, month = (year - 1, 12) if month == 1 else (year, month - 1)
    try:
        _s, end = period_range(f"{year:04d}-{month:02d}")
        return f"{end}T23:59:59"
    except ConnectorError:
        return None


def _metric_history(dest, period) -> dict:
    """Collect prior months' metric rows from every period folder, so the
    synced file carries the full history the delta logic needs."""
    history = {}
    data_root = dest.parent.parent  # data/{client}/
    if not data_root.exists():
        return history
    for path in sorted(data_root.glob("*/technical_seo_metrics*.csv")):
        try:
            with open(path, newline="", encoding="utf-8") as f:
                for r in _csv.DictReader(f):
                    month = (r.get("month") or "").strip()
                    if month and month != period:
                        history[month] = {c: (r.get(c) or "").strip() for c in METRIC_COLS}
        except OSError:
            continue
    return history


def write_backlinks_csv(rows, dest):
    """API rows -> UI-export-shaped CSV that parse_ahrefs understands."""
    header = ["Referring page URL", "Domain rating", "Target URL", "Anchor", "First seen"]
    out = [
        [
            r.get("url_from", ""),
            r.get("domain_rating_source", ""),
            r.get("url_to", ""),
            r.get("anchor", ""),
            r.get("first_seen", ""),
        ]
        for r in rows
    ]
    write_csv(dest, header, out)
