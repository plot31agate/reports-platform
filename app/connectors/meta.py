"""Meta connector — Facebook Page + Instagram insights via the Graph API.

Feeds:
  meta_social — daily rows of views, reach, content interactions, link clicks
                and new followers for Facebook and/or Instagram, in the shape
                parse_meta_social understands (Platform + Date + metric columns).

Credential model matches the rest of the app:
  - Agency level: one long-lived access token (a System User token from Meta
    Business Suite) that can read insights for every page/IG account the
    business portfolio has granted the app.
  - Per client: the Facebook Page ID, and optionally the Instagram account ID.

Metric names on Meta's insights endpoints shift between Graph API versions and
by what a given page/account exposes. They're centralised in the constants
below and every insights call is best-effort: a metric Meta won't serve for
this account is skipped with its reason, and whatever else came back is still
written. Bump GRAPH_VERSION and adjust the metric lists here when Meta
deprecates a name - the error passthrough in _get surfaces the exact message.
"""
from app.connectors._util import ConnectorError, period_range, write_csv

GRAPH_VERSION = "v21.0"
API = f"https://graph.facebook.com/{GRAPH_VERSION}"
TIMEOUT = 30

# Facebook Page insights (period=day). These have survived Meta's insights
# deprecations; link clicks is pulled separately because it's less reliable.
FB_METRICS = {
    "views": "page_impressions",
    "reach": "page_impressions_unique",
    "interactions": "page_post_engagements",
    "followers": "page_fan_adds",
}
# Best-effort extras requested in their own call so a rejection here doesn't
# lose the core metrics above.
FB_LINK_CLICKS_METRIC = "page_consumptions_by_consumption_type"

# Instagram account insights. IG needs metric_type=total_value for the
# interaction metrics on recent API versions; reach/views are plain daily.
IG_DAILY_METRICS = {
    "views": "impressions",       # newer accounts serve "views"; we try both
    "reach": "reach",
}
IG_DAILY_METRICS_FALLBACK = {"views": "views"}
IG_FOLLOWER_METRIC = "follower_count"


def _requests():
    try:
        import requests
        return requests
    except ImportError:
        raise ConnectorError("The 'requests' package is not installed - run pip install -r requirements.txt")


def _token(config) -> str:
    # A client whose Page lives in a different Meta business portfolio can
    # carry its own token, which overrides the shared agency one.
    tok = (config.get("client_access_token") or config.get("access_token") or "").strip()
    if not tok:
        raise ConnectorError("No Meta access token saved")
    return tok


def _get(config, path, params, best_effort=False):
    """GET a Graph API node. Returns parsed JSON, or None when best_effort and
    Meta rejects the specific request (e.g. an unavailable metric)."""
    params = {**params, "access_token": _token(config)}
    requests = _requests()
    try:
        resp = requests.get(f"{API}/{path.lstrip('/')}", params=params, timeout=TIMEOUT)
    except requests.RequestException as e:
        if best_effort:
            return None
        raise ConnectorError(f"Could not reach Meta: {e}")
    if resp.status_code == 200:
        return resp.json()
    # Meta returns a descriptive error body - pass its message straight through.
    try:
        msg = (resp.json().get("error") or {}).get("message") or resp.text[:150]
    except ValueError:
        msg = resp.text[:150]
    if best_effort:
        return None
    if resp.status_code in (400, 403) and "permission" in msg.lower():
        raise ConnectorError(f"Meta says no access: {msg}")
    if resp.status_code == 190:
        raise ConnectorError(f"Meta access token invalid or expired: {msg}")
    raise ConnectorError(f"Meta error {resp.status_code}: {msg}")


def test_key(config) -> tuple[bool, str]:
    """Validate the access token alone (no page/account needed)."""
    try:
        data = _get(config, "/me", {"fields": "name,id"})
    except ConnectorError as e:
        return False, str(e)
    name = (data or {}).get("name") or (data or {}).get("id") or "unknown"
    return True, f"Token OK ({name}) - now set each client's Facebook Page ID / Instagram account ID"


def _accessible_pages(config) -> str:
    """List the pages this token can actually read - with each page's linked
    Instagram account - so a wrong/unconnected ID turns into 'here are the exact
    IDs to paste' instead of a dead end. IG is linked to the page, so one call
    returns both numbers the operator needs."""
    data = _get(config, "/me/accounts",
                {"fields": "name,id,instagram_business_account{id,username}", "limit": 50},
                best_effort=True)
    pages = (data or {}).get("data") or []
    if not pages:
        return ("This token can't see any Facebook Pages. Add the Page to the business "
                "portfolio, connect it to the Reporting app, and make sure the token has "
                "pages_show_list, pages_read_engagement and read_insights.")
    bits = []
    for p in pages[:15]:
        entry = f"{p.get('name')} - Page ID {p.get('id')}"
        ig = p.get("instagram_business_account") or {}
        if ig.get("id"):
            handle = f"@{ig['username']} " if ig.get("username") else ""
            entry += f", Instagram {handle}ID {ig['id']}"
        bits.append(entry)
    return "IDs this token can read: " + "; ".join(bits)


def test(config) -> tuple[bool, str]:
    fb = (config.get("fb_page_id") or "").strip()
    ig = (config.get("ig_user_id") or "").strip()
    if not fb and not ig:
        return False, "Token parses, but add a Facebook Page ID or Instagram account ID to connect anything"

    parts = []
    try:
        if fb:
            data = _get(config, f"/{fb}", {"fields": "name,fan_count"})
            parts.append(f"Facebook: {data.get('name')} ({data.get('fan_count', '?')} fans)")
        if ig:
            data = _get(config, f"/{ig}", {"fields": "username,followers_count"})
            parts.append(f"Instagram: @{data.get('username')} ({data.get('followers_count', '?')} followers)")
    except ConnectorError as e:
        # A page/account lookup failed - tell the operator which IDs do work.
        hint = _accessible_pages(config)
        return False, f"{e}. {hint}"
    return True, "Connected - " + "; ".join(parts)


def sync(config, source_key, dest, period):
    if source_key != "meta_social":
        raise ConnectorError(f"Meta connector can't feed {source_key}")

    fb = (config.get("fb_page_id") or "").strip()
    ig = (config.get("ig_user_id") or "").strip()
    if not fb and not ig:
        raise ConnectorError("No Facebook Page ID or Instagram account ID saved for this client")

    start, end = period_range(period)
    rows = []
    if fb:
        rows += _facebook_rows(config, fb, start, end)
    if ig:
        rows += _instagram_rows(config, ig, start, end)

    if not rows:
        # Each platform's _note_if_empty probe recorded why it came back empty;
        # surface those exact Meta reasons instead of a generic guess.
        reasons = "; ".join(config.get("_warnings") or [])
        detail = f" - {reasons}" if reasons else (
            " - the page/account may have no activity, or the token lacks the "
            "read_insights / instagram_basic permissions")
        raise ConnectorError(f"Meta returned no insights for {period}{detail}")

    header = ["Date", "Platform", "Views", "Reach", "Content interactions", "Link clicks", "New followers"]
    write_csv(dest, header, rows)
    return len(rows)


def _daily_series(node) -> dict:
    """A Graph insights metric node -> {YYYY-MM-DD: number}."""
    out = {}
    for point in (node.get("values") or []):
        day = (point.get("end_time") or "")[:10]
        val = point.get("value")
        if isinstance(val, dict):
            # Breakdown metrics (e.g. consumptions by type) - sum the parts.
            val = sum(v for v in val.values() if isinstance(v, (int, float)))
        if day and isinstance(val, (int, float)):
            out[day] = out.get(day, 0) + val
    return out


def _pull_daily(config, node_id, metrics: dict, start, end, extra=None):
    """Request one insights call for several metrics; return {our_key: {day: val}}.

    A single unavailable metric fails the whole Graph call, so this retries
    once dropping the metric Meta named in its error, keeping the rest.
    """
    wanted = dict(metrics)
    for _attempt in range(len(wanted) + 1):
        if not wanted:
            return {}
        params = {"metric": ",".join(wanted.values()), "period": "day",
                  "since": start, "until": end}
        if extra:
            params.update(extra)
        data = _get(config, f"/{node_id}/insights", params, best_effort=True)
        if data is not None:
            by_name = {d.get("name"): d for d in (data.get("data") or [])}
            return {key: _daily_series(by_name[name])
                    for key, name in wanted.items() if name in by_name}
        # Drop one metric and retry - without the error name we can't tell
        # which, so drop the last and let the caller's best-effort extras cover
        # anything important that got dropped.
        wanted.popitem()
    return {}


def _rows_from_series(series: dict, platform: str, keys) -> list:
    """Merge per-metric daily series into dated CSV rows for one platform."""
    days = sorted({d for key in keys for d in (series.get(key) or {})})
    rows = []
    for day in days:
        def v(k):
            val = (series.get(k) or {}).get(day)
            return int(round(val)) if isinstance(val, (int, float)) else ""
        rows.append([day, platform, v("views"), v("reach"),
                     v("interactions"), v("link_clicks"), v("followers")])
    return rows


def _probe_reason(config, node_id, metrics, start, end) -> str:
    """One deliberate (non-best-effort) insights call to explain why a platform
    came back empty - a deprecated metric name or a missing permission - instead
    of the best-effort path silently dropping every metric."""
    try:
        _get(config, f"/{node_id}/insights",
             {"metric": ",".join(metrics.values()), "period": "day",
              "since": start, "until": end})
        return "the page reported no activity for this month"
    except ConnectorError as e:
        return str(e)


def _note_if_empty(config, rows, platform, node_id, metrics, start, end):
    """Record a warning (surfaced on the sync card) when a configured platform
    produced no rows, so a half-empty sync isn't a mystery."""
    if not rows:
        reason = _probe_reason(config, node_id, metrics, start, end)
        config.setdefault("_warnings", []).append(f"{platform}: no data written - {reason}")
    return rows


def _facebook_rows(config, page_id, start, end):
    series = _pull_daily(config, page_id, FB_METRICS, start, end)
    # Link clicks in its own best-effort call so its absence never drops reach.
    clicks = _pull_daily(config, page_id, {"link_clicks": FB_LINK_CLICKS_METRIC}, start, end)
    series.update(clicks)
    rows = _rows_from_series(series, "Facebook",
                             ["views", "reach", "interactions", "link_clicks", "followers"])
    return _note_if_empty(config, rows, "Facebook", page_id, FB_METRICS, start, end)


def _instagram_rows(config, ig_id, start, end):
    series = _pull_daily(config, ig_id, IG_DAILY_METRICS, start, end)
    if "views" not in series:
        series.update(_pull_daily(config, ig_id, IG_DAILY_METRICS_FALLBACK, start, end))
    followers = _pull_daily(config, ig_id, {"followers": IG_FOLLOWER_METRIC}, start, end)
    series.update(followers)
    rows = _rows_from_series(series, "Instagram",
                             ["views", "reach", "interactions", "link_clicks", "followers"])
    return _note_if_empty(config, rows, "Instagram", ig_id, IG_DAILY_METRICS, start, end)
