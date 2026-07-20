"""Google connector — GA4 Data API + Search Console API via one service account.

Feeds:
  ga4_export     — CSV shaped like a GA4 Traffic acquisition export
                   (channel group, Sessions, Users, Engaged sessions)
  ga4_geography  — CSV of Country, Sessions
  search_console — CSV shaped like a GSC Queries export, straight from the
                   Search Console API. Works with no Ahrefs project at all;
                   clients whose GSC is linked to an Ahrefs project can keep
                   using GSC Insights instead (the Ahrefs route stays as the
                   fallback when no site URL is set here).

Setup on the Google side: create a service account, then add its email as a
viewer on each GA4 property and as a user on each Search Console property.
"""
import json
from urllib.parse import quote

from app.connectors._util import ConnectorError, period_range, write_csv

TIMEOUT = 30
SCOPES = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
]


def _session(config):
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except ImportError:
        raise ConnectorError("google-auth is not installed - run pip install -r requirements.txt")

    raw = (config.get("service_account_json") or "").strip()
    if not raw:
        raise ConnectorError("No service account JSON saved")
    try:
        info = json.loads(raw)
    except ValueError:
        raise ConnectorError("Service account JSON does not parse - paste the whole key file")
    if info.get("type") != "service_account" or not info.get("client_email"):
        raise ConnectorError("That JSON is not a service account key (needs type=service_account)")
    try:
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    except Exception as e:
        raise ConnectorError(f"Service account key rejected: {e}")
    return AuthorizedSession(creds), info["client_email"]


def _post(session, url, payload, provider_label):
    try:
        resp = session.post(url, json=payload, timeout=TIMEOUT)
    except Exception as e:
        raise ConnectorError(f"Could not reach {provider_label}: {e}")
    if resp.status_code == 403:
        grant = ("add the service account email as a user on the property in Search Console settings"
                 if provider_label == "Search Console"
                 else "add the service account email as a viewer")
        raise ConnectorError(f"{provider_label} says no access (403) - {grant} and retry")
    if resp.status_code != 200:
        raise ConnectorError(f"{provider_label} error {resp.status_code}: {resp.text[:150]}")
    return resp.json()


def _normalise_site(site: str) -> str:
    """Accept a bare domain, a URL, or an sc-domain: property as saved.

    'example.com'          -> 'sc-domain:example.com' (domain property)
    'https://example.com/' -> unchanged (URL-prefix property)
    'sc-domain:example.com'-> unchanged
    """
    site = site.strip().rstrip()
    if site.startswith("sc-domain:") or site.startswith("http://") or site.startswith("https://"):
        return site
    return f"sc-domain:{site.lower().strip('/').removeprefix('www.')}"


def _gsc_query(session, site, start, end, limit=1000):
    url = (
        "https://searchconsole.googleapis.com/webmasters/v3/sites/"
        f"{quote(_normalise_site(site), safe='')}/searchAnalytics/query"
    )
    payload = {
        "startDate": start,
        "endDate": end,
        "dimensions": ["query"],
        "rowLimit": limit,
    }
    return _post(session, url, payload, "Search Console")


def _ga4_report(session, property_id, start, end, dimensions, metrics, limit=100):
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"
    payload = {
        "dateRanges": [{"startDate": start, "endDate": end}],
        "dimensions": [{"name": d} for d in dimensions],
        "metrics": [{"name": m} for m in metrics],
        "limit": limit,
    }
    return _post(session, url, payload, "GA4")


def test_key(config) -> tuple[bool, str]:
    """Validate the service account JSON alone (no per-client properties)."""
    try:
        _session_obj, email = _session(config)
        return True, f"Service account key OK ({email}) - remember to add this email as a viewer on each client's GA4 property"
    except ConnectorError as e:
        return False, str(e)


def test(config) -> tuple[bool, str]:
    try:
        session, email = _session(config)
    except ConnectorError as e:
        return False, str(e)

    prop = (config.get("ga4_property_id") or "").strip()
    site = (config.get("gsc_site_url") or "").strip()
    if not prop and not site:
        return False, "Key parses, but add a GA4 property ID or a Search Console property to connect anything"

    start, end = period_range_last_week()
    parts = []
    if prop:
        try:
            _ga4_report(session, prop, start, end, ["sessionDefaultChannelGroup"], ["sessions"], limit=5)
            parts.append("GA4 OK")
        except ConnectorError as e:
            return False, f"GA4: {e}"
    if site:
        try:
            _gsc_query(session, site, start, end, limit=5)
            parts.append("Search Console OK")
        except ConnectorError as e:
            return False, f"Search Console: {e}"
    return True, f"Key OK ({email}) - " + ", ".join(parts)


def period_range_last_week():
    from datetime import date, timedelta
    today = date.today()
    return (today - timedelta(days=8)).isoformat(), (today - timedelta(days=1)).isoformat()


def sync(config, source_key, dest, period):
    session, _email = _session(config)
    start, end = period_range(period)

    if source_key == "ga4_export":
        prop = (config.get("ga4_property_id") or "").strip()
        if not prop:
            raise ConnectorError("No GA4 property ID saved")
        data = _ga4_report(
            session, prop, start, end,
            ["sessionDefaultChannelGroup"],
            ["sessions", "totalUsers", "engagedSessions", "newUsers", "userEngagementDuration"],
        )
        rows = data.get("rows") or []
        write_ga4_csv(rows, dest)
        return len(rows)

    if source_key == "ga4_geography":
        prop = (config.get("ga4_property_id") or "").strip()
        if not prop:
            raise ConnectorError("No GA4 property ID saved")
        data = _ga4_report(session, prop, start, end, ["country"], ["sessions"], limit=250)
        rows = data.get("rows") or []
        write_geo_csv(rows, dest)
        return len(rows)

    if source_key == "search_console":
        site = (config.get("gsc_site_url") or "").strip()
        if not site:
            raise ConnectorError("No Search Console property saved")
        data = _gsc_query(session, site, start, end)
        rows = data.get("rows") or []
        if not rows:
            raise ConnectorError(
                f"Search Console returned no query rows for {period} - "
                "check the property spelling and that the period has data"
            )
        write_gsc_csv(rows, dest)
        return len(rows)

    raise ConnectorError(f"Google connector can't feed {source_key}")


def write_gsc_csv(rows, dest):
    """Search Analytics rows -> Queries-export-shaped CSV for parse_search_console.

    Same shape as the Ahrefs GSC Insights CSV, so the parser and report are
    identical whichever route fed the data. CTR is recomputed from
    clicks/impressions rather than trusting the API's fraction.
    """
    header = ["Top queries", "Clicks", "Impressions", "CTR", "Position"]
    out = []
    for r in rows:
        keys = r.get("keys") or [""]
        clicks = int(round(r.get("clicks") or 0))
        impressions = int(round(r.get("impressions") or 0))
        ctr = round(clicks / impressions * 100, 2) if impressions else 0.0
        out.append([
            keys[0],
            clicks,
            impressions,
            f"{ctr}%",
            round(float(r.get("position") or 0), 1),
        ])
    out.sort(key=lambda row: row[1], reverse=True)
    write_csv(dest, header, out)


def write_ga4_csv(rows, dest):
    """GA4 API rows -> Traffic-acquisition-export-shaped CSV for parse_ga4."""
    header = [
        "Session primary channel group (Default Channel Group)",
        "Sessions", "Users", "Engaged sessions",
        "New users", "User engagement duration",
    ]
    out = []
    for r in rows:
        dims = r.get("dimensionValues") or []
        mets = r.get("metricValues") or []
        channel = dims[0].get("value", "") if dims else ""
        vals = [m.get("value", "0") for m in mets] + ["0"] * 5
        out.append([channel, vals[0], vals[1], vals[2], vals[3], vals[4]])
    write_csv(dest, header, out)


def write_geo_csv(rows, dest):
    """GA4 country rows -> CSV for parse_ga4_geography (Country, Sessions)."""
    out = []
    for r in rows:
        dims = r.get("dimensionValues") or []
        mets = r.get("metricValues") or []
        country = dims[0].get("value", "") if dims else ""
        sessions = mets[0].get("value", "0") if mets else "0"
        out.append([country, sessions])
    write_csv(dest, ["Country", "Sessions"], out)
