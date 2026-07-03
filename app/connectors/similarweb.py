"""Similarweb API connector.

Feeds: similarweb_traffic — writes a CSV with a "Visits" column the existing
parse_similarweb reads unchanged.
"""
import requests

from app.connectors._util import ConnectorError, write_csv

API = "https://api.similarweb.com"
TIMEOUT = 30


def _key(config):
    key = (config.get("api_key") or "").strip()
    if not key:
        raise ConnectorError("No API key saved")
    return key


def _domain(config):
    d = (config.get("domain") or "").strip().lower()
    d = d.replace("https://", "").replace("http://", "").strip("/")
    if d.startswith("www."):
        d = d[4:]
    if not d:
        raise ConnectorError("No domain saved")
    return d


def _get(config, path, params):
    params = {**params, "api_key": _key(config), "format": "json"}
    try:
        resp = requests.get(f"{API}{path}", params=params, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise ConnectorError(f"Could not reach Similarweb: {e}")
    if resp.status_code == 401:
        raise ConnectorError("Similarweb rejected the API key (401)")
    if resp.status_code == 403:
        raise ConnectorError("Similarweb key lacks access (403) - check your API plan covers this endpoint")
    if resp.status_code != 200:
        raise ConnectorError(f"Similarweb error {resp.status_code}: {resp.text[:150]}")
    return resp.json()


def test(config) -> tuple[bool, str]:
    try:
        _key(config)
        domain = _domain(config)
        data = _get(config, "/capabilities", {})
        # capabilities returns account remaining hits etc.
        remaining = (data.get("remaining_hits")
                     or (data.get("user_data") or {}).get("remaining_hits"))
        msg = f"Connected for {domain}"
        if remaining is not None:
            msg += f" - {remaining} API hits remaining"
        return True, msg
    except ConnectorError as e:
        return False, str(e)


def sync(config, source_key, dest, period):
    if source_key != "similarweb_traffic":
        raise ConnectorError(f"Similarweb connector can't feed {source_key}")
    # Monthly granularity needs a complete month - Similarweb data also lags,
    # so a just-finished month may not be available yet; surface their error.
    data = _get(config, f"/v1/website/{_domain(config)}/total-traffic-and-engagement/visits", {
        "start_date": period,
        "end_date": period,
        "country": "world",
        "granularity": "monthly",
        "main_domain_only": "false",
        "show_verified": "false",
    })
    visits_rows = data.get("visits") or []
    if not visits_rows:
        raise ConnectorError(f"Similarweb returned no visits for {period} - data for that month may not be published yet")
    total = sum(int(r.get("visits") or 0) for r in visits_rows)
    write_visits_csv(total, dest)
    return total


def write_visits_csv(total_visits, dest):
    write_csv(dest, ["Visits"], [[total_visits]])
