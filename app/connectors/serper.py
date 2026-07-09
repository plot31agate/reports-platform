"""Serper.dev connector — media mentions from Google News.

Feeds:
  mentions — one CSV (date, source, title, url, snippet) shaped exactly like
             the Google Alerts export, so parse_mentions and everything
             downstream is unchanged.

One agency API key (serper.dev) covers every client. Per client you set the
search queries - typically the brand name plus executive and product names,
one per line. If left blank the connector falls back to the client's display
name and tracked executives.

Date scoping: a paid Serper key can use Google's custom date-range filter
(tbs=cdr) to pull only the report month. Free keys reject that filter
("Query pattern not allowed for free accounts"), so the connector retries
without it and filters results to the month by their published date instead.
On a free key that means historical months only return what Google still
surfaces as recent - the current/just-finished month works, older months are
better served by a paid key or a manual upload.
"""
import re
from datetime import datetime, timedelta

from app.connectors._util import ConnectorError, period_range, write_csv

NEWS_URL = "https://google.serper.dev/news"
TIMEOUT = 20
MAX_QUERIES = 15          # guard against a runaway query list
RESULTS_PER_QUERY = 100   # Serper max per call


def _requests():
    try:
        import requests
        return requests
    except ImportError:
        raise ConnectorError("The 'requests' package is not installed - run pip install -r requirements.txt")


def _api_key(config) -> str:
    key = (config.get("api_key") or "").strip()
    if not key:
        raise ConnectorError("No Serper API key saved - add it on the API keys page")
    return key


def _queries(config) -> list[str]:
    """Search phrases for this client: the explicit list if set, else the
    client's brand name plus tracked executives."""
    raw = (config.get("mention_queries") or "").strip()
    if raw:
        qs = [line.strip() for line in raw.splitlines() if line.strip()]
    else:
        qs = []
        name = (config.get("_display_name") or "").strip()
        if name:
            qs.append(name)
        qs += [e for e in (config.get("_executives") or []) if e and e.strip()]
    # De-dupe, preserve order, cap.
    seen, out = set(), []
    for q in qs:
        k = q.lower()
        if k not in seen:
            seen.add(k)
            out.append(q)
    return out[:MAX_QUERIES]


def _tbs(period: str) -> str:
    """Google custom date range for the report month, e.g.
    cdr:1,cd_min:6/1/2026,cd_max:6/30/2026. Paid keys only."""
    start, end = period_range(period)
    s = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    return f"cdr:1,cd_min:{s.month}/{s.day}/{s.year},cd_max:{e.month}/{e.day}/{e.year}"


def _domain(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url or "")
    return m.group(1) if m else ""


def _parse_date(raw: str):
    """Serper's date string -> a date, or None if it can't be read.
    Handles absolute formats and relative phrases ('3 days ago', 'yesterday')."""
    raw = (raw or "").strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    m = re.match(r"(\d+)\s+(hour|minute|day|week|month)s?\s+ago", raw, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        days = {"minute": 0, "hour": 0, "day": 1, "week": 7, "month": 30}[unit] * n
        return (datetime.utcnow() - timedelta(days=days)).date()
    low = raw.lower()
    if low in ("just now", "today"):
        return datetime.utcnow().date()
    if low == "yesterday":
        return (datetime.utcnow() - timedelta(days=1)).date()
    return None


def _post(config, query, tbs=None):
    """POST one query to Serper News. Returns (news_list, tbs_applied).

    Free accounts reject the tbs date filter - on that specific 400 we retry
    without it and tell the caller (tbs_applied=False) so it filters by date.
    """
    requests = _requests()
    key = _api_key(config)

    def _do(payload):
        try:
            return requests.post(
                NEWS_URL,
                headers={"X-API-KEY": key, "Content-Type": "application/json"},
                json=payload, timeout=TIMEOUT,
            )
        except Exception as e:
            raise ConnectorError(f"Could not reach Serper: {e}")

    payload = {"q": query, "num": RESULTS_PER_QUERY, "gl": "us", "hl": "en"}
    if tbs:
        payload["tbs"] = tbs
    resp = _do(payload)
    tbs_applied = bool(tbs)

    if resp.status_code == 400 and tbs and "free account" in resp.text.lower():
        payload.pop("tbs", None)
        resp = _do(payload)
        tbs_applied = False

    if resp.status_code in (401, 403):
        raise ConnectorError("Serper rejected the API key (401/403) - check it on the API keys page")
    if resp.status_code == 429:
        raise ConnectorError("Serper rate limit / out of credits (429)")
    if resp.status_code != 200:
        raise ConnectorError(f"Serper error {resp.status_code}: {resp.text[:150]}")
    return resp.json().get("news", []) or [], tbs_applied


# ------------------- connector interface -------------------

def test_key(config) -> tuple[bool, str]:
    """Validate the agency key alone with a tiny query (no date filter, so it
    works on free and paid keys alike)."""
    try:
        _post(config, "news")
        return True, "Serper API key OK"
    except ConnectorError as e:
        return False, str(e)


def test(config) -> tuple[bool, str]:
    """Full round-trip: the client's first real query."""
    try:
        qs = _queries(config)
        if not qs:
            return False, "Add at least one search query (or set the client's brand name and executives)"
        items, _ = _post(config, qs[0])
        return True, f"Connected - '{qs[0]}' returned {len(items)} stories ({len(qs)} quer{'y' if len(qs) == 1 else 'ies'} configured)"
    except ConnectorError as e:
        return False, str(e)


def sync(config, source_key, dest, period):
    if source_key != "mentions":
        raise ConnectorError(f"Serper connector can't feed {source_key}")

    queries = _queries(config)
    if not queries:
        raise ConnectorError(
            "No search queries for this client - set the mention queries (or the client's brand name and executives)"
        )

    start, end = period_range(period)
    lo = datetime.strptime(start, "%Y-%m-%d").date()
    hi = datetime.strptime(end, "%Y-%m-%d").date()
    tbs = _tbs(period)

    seen, rows, dropped = set(), [], 0
    for q in queries:
        news, tbs_applied = _post(config, q, tbs)
        for item in news:
            url = (item.get("link") or "").strip()
            title = (item.get("title") or "").strip()
            if not (url or title):
                continue

            d = _parse_date(item.get("date"))
            if d is not None:
                if d < lo or d > hi:
                    dropped += 1          # dated outside the report month
                    continue
                date_str = d.isoformat()
            elif tbs_applied:
                date_str = start          # tbs guaranteed in-period, day unknown
            else:
                dropped += 1              # undated and unscoped - can't trust it
                continue

            key = (url.lower().rstrip("/"), title.lower())
            if key in seen:
                continue
            seen.add(key)
            rows.append([
                date_str,
                (item.get("source") or _domain(url)).strip(),
                title,
                url,
                (item.get("snippet") or "").strip()[:300],
            ])

    rows.sort(key=lambda r: r[0])
    write_csv(dest, ["date", "source", "title", "url", "snippet"], rows)
    return {"rows": len(rows), "queries": len(queries), "dropped_out_of_period": dropped}
