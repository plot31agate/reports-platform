"""Serper.dev connector — media mentions from Google News.

Feeds:
  mentions — one CSV (date, source, title, url, snippet) shaped exactly like
             the Google Alerts export, so parse_mentions and everything
             downstream is unchanged.

One agency API key (serper.dev) covers every client. Per client you set the
search queries - typically the brand name plus executive and product names,
one per line. If left blank the connector falls back to the client's display
name and tracked executives.

Each query is constrained to the report month via Google's date-range filter
(tbs=cdr), so results are already in-period and relative dates ("3 days ago")
never need parsing.
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
    cdr:1,cd_min:6/1/2026,cd_max:6/30/2026."""
    start, end = period_range(period)
    s = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    return f"cdr:1,cd_min:{s.month}/{s.day}/{s.year},cd_max:{e.month}/{e.day}/{e.year}"


def _domain(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url or "")
    return m.group(1) if m else ""


def _parse_date(raw: str, start: str, end: str) -> str:
    """Best-effort YYYY-MM-DD, clamped to the report month. Results are already
    inside the month (the query is date-range constrained), so a relative or
    unparseable date is clamped to the nearest bound rather than trusted to
    fall outside the period."""
    raw = (raw or "").strip()
    lo = datetime.strptime(start, "%Y-%m-%d")
    hi = datetime.strptime(end, "%Y-%m-%d")
    cand = None
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            cand = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue
    if cand is None:
        m = re.match(r"(\d+)\s+(hour|day|week|month)s?\s+ago", raw, re.I)
        if m:
            n, unit = int(m.group(1)), m.group(2).lower()
            days = {"hour": 0, "day": 1, "week": 7, "month": 30}[unit] * n
            cand = datetime.utcnow() - timedelta(days=days)
    if cand is None:
        cand = lo
    cand = min(max(cand, lo), hi)
    return cand.strftime("%Y-%m-%d")


def _post(config, query, tbs):
    requests = _requests()
    try:
        resp = requests.post(
            NEWS_URL,
            headers={"X-API-KEY": _api_key(config), "Content-Type": "application/json"},
            json={"q": query, "num": RESULTS_PER_QUERY, "tbs": tbs, "gl": "us", "hl": "en"},
            timeout=TIMEOUT,
        )
    except Exception as e:
        raise ConnectorError(f"Could not reach Serper: {e}")
    if resp.status_code in (401, 403):
        raise ConnectorError("Serper rejected the API key (401/403) - check it on the API keys page")
    if resp.status_code == 429:
        raise ConnectorError("Serper rate limit / out of credits (429)")
    if resp.status_code != 200:
        raise ConnectorError(f"Serper error {resp.status_code}: {resp.text[:150]}")
    return resp.json().get("news", []) or []


# ------------------- connector interface -------------------

def test_key(config) -> tuple[bool, str]:
    """Validate the agency key alone with a tiny query."""
    try:
        _post(config, "test", "cdr:1,cd_min:1/1/2020,cd_max:1/2/2020")
        return True, "Serper API key OK"
    except ConnectorError as e:
        return False, str(e)


def test(config) -> tuple[bool, str]:
    """Full round-trip: the client's real queries over the last 30 days."""
    try:
        qs = _queries(config)
        if not qs:
            return False, "Add at least one search query (or set the client's brand name and executives)"
        items = _post(config, qs[0], "qdr:m")
        return True, f"Connected - '{qs[0]}' returned {len(items)} recent stories ({len(qs)} quer{'y' if len(qs) == 1 else 'ies'} configured)"
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
    tbs = _tbs(period)
    seen, rows = set(), []
    for q in queries:
        for item in _post(config, q, tbs):
            url = (item.get("link") or "").strip()
            title = (item.get("title") or "").strip()
            if not (url or title):
                continue
            key = (url.lower().rstrip("/"), title.lower())
            if key in seen:
                continue
            seen.add(key)
            rows.append([
                _parse_date(item.get("date"), start, end),
                (item.get("source") or _domain(url)).strip(),
                title,
                url,
                (item.get("snippet") or "").strip()[:300],
            ])

    rows.sort(key=lambda r: r[0])
    write_csv(dest, ["date", "source", "title", "url", "snippet"], rows)
    return {"rows": len(rows), "queries": len(queries)}
