"""Ahrefs API v3 connector.

Feeds: ahrefs_backlinks — writes a CSV shaped like the Ahrefs UI backlinks
export ("Referring page URL", "Domain rating", ...) so parse_ahrefs reads it
unchanged.
"""
from datetime import date

from app.connectors._util import ConnectorError, write_csv

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
    if source_key != "ahrefs_backlinks":
        raise ConnectorError(f"Ahrefs connector can't feed {source_key}")
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
