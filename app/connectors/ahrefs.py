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

    raise ConnectorError(f"Ahrefs connector can't feed {source_key}")


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
