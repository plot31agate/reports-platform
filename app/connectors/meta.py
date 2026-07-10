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

# Facebook Page insights (period=day). Meta's 2025-11-15 purge removed the
# impression- and fan-based names; these are the current replacements. Page
# insights must be called with a *Page* access token (the user/system token
# 400s with #190), which _fb_page_token exchanges per page. page_impressions_
# unique (reach) and page_consumptions_by_consumption_type (link clicks) were
# removed outright with no replacement, so those Facebook columns stay blank.
# Names keep shifting - _pull_daily isolates each metric, so a dead name drops
# out named in a warning instead of nuking the whole call.
FB_METRICS = {
    "views": "page_media_view",          # was page_impressions
    "interactions": "page_post_engagements",
    "followers": "page_daily_follows",   # was page_fan_adds
}

# Instagram account insights. reach and follower_count are daily time series;
# "views" (which replaced the deprecated "impressions") is only served as
# metric_type=total_value, so _ig_views_by_day fetches it one day at a time.
IG_DAILY_METRICS = {
    "reach": "reach",
}
IG_VIEWS_METRIC = "views"
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


def _get(config, path, params, best_effort=False, token=None):
    """GET a Graph API node. Returns parsed JSON, or None when best_effort and
    Meta rejects the specific request (e.g. an unavailable metric). Pass token
    to use a specific credential (e.g. a Page token) over the configured one."""
    params = {**params, "access_token": token or _token(config)}
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


def _fb_page_token(config, page_id) -> str:
    """Exchange the configured user/system token for the Page's own token.
    Page insights reject anything else with '#190 must be called with a Page
    Access Token'. Cached on the config dict for the life of one sync."""
    cache_key = f"_page_token_{page_id}"
    if config.get(cache_key):
        return config[cache_key]
    data = _get(config, f"/{page_id}", {"fields": "access_token"}, best_effort=True)
    tok = (data or {}).get("access_token")
    if not tok:
        raise ConnectorError(
            f"Couldn't get a Page token for {page_id} - the configured token must "
            "manage this Page (grant the Page to the system user with full control, "
            "and include the pages_show_list and pages_read_engagement permissions)"
        )
    config[cache_key] = tok
    return tok


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


def _pull_daily(config, node_id, metrics: dict, start, end, extra=None, token=None):
    """Return {our_key: {day: value}} for several insights metrics.

    Meta rejects the whole call if any single metric name is invalid (routine as
    it deprecates names), so the batch is only a fast path: on failure we fetch
    each metric on its own, so a dead name drops out - recorded as a warning
    naming the exact metric - and every still-valid metric comes through.
    """
    if not metrics:
        return {}
    base = {"period": "day", "since": start, "until": end}
    if extra:
        base.update(extra)

    def _series(data):
        by_name = {d.get("name"): d for d in (data.get("data") or [])}
        return {key: _daily_series(by_name[name])
                for key, name in metrics.items() if name in by_name}

    batch = _get(config, f"/{node_id}/insights",
                 {**base, "metric": ",".join(metrics.values())}, best_effort=True, token=token)
    if batch is not None:
        got = _series(batch)
        if got:
            return got

    out = {}
    for key, name in metrics.items():
        one = _get(config, f"/{node_id}/insights", {**base, "metric": name},
                   best_effort=True, token=token)
        series = _series(one) if one is not None else {}
        if series:
            out.update(series)
        else:
            # Capture Meta's exact reason for this metric so we know what to fix.
            try:
                _get(config, f"/{node_id}/insights", {**base, "metric": name}, token=token)
                reason = "returned no rows for this month"
            except ConnectorError as e:
                reason = str(e)
            config.setdefault("_warnings", []).append(f"{name}: {reason}")
    return out


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


def _note_if_empty(config, rows, platform):
    """Record a warning (surfaced on the sync card) when a configured platform
    produced no rows. _pull_daily already recorded each metric's exact rejection,
    so this just marks the platform-level outcome."""
    if not rows:
        config.setdefault("_warnings", []).append(
            f"{platform}: no data written - see the metric errors above")
    return rows


def _facebook_rows(config, page_id, start, end):
    # Page insights only answer to the Page's own token (#190 otherwise).
    try:
        page_token = _fb_page_token(config, page_id)
    except ConnectorError as e:
        config.setdefault("_warnings", []).append(f"Facebook: no data written - {e}")
        return []
    series = _pull_daily(config, page_id, FB_METRICS, start, end, token=page_token)
    rows = _rows_from_series(series, "Facebook",
                             ["views", "reach", "interactions", "link_clicks", "followers"])
    return _note_if_empty(config, rows, "Facebook")


def _ig_views_by_day(config, ig_id, start, end) -> dict:
    """Daily series for IG views, which Meta only serves aggregated
    (metric_type=total_value) - so ask for each day's total separately."""
    from datetime import date, timedelta
    out = {}
    day = date.fromisoformat(start)
    last = date.fromisoformat(end)
    failed = None
    while day <= last:
        data = _get(config, f"/{ig_id}/insights",
                    {"metric": IG_VIEWS_METRIC, "period": "day",
                     "metric_type": "total_value",
                     "since": day.isoformat(), "until": (day + timedelta(days=1)).isoformat()},
                    best_effort=True)
        for node in ((data or {}).get("data") or []):
            val = (node.get("total_value") or {}).get("value")
            if isinstance(val, (int, float)):
                out[day.isoformat()] = val
        if data is None:
            failed = day.isoformat()
        day += timedelta(days=1)
    if failed and not out:
        # Every day failed - capture Meta's reason once, from the last day.
        try:
            _get(config, f"/{ig_id}/insights",
                 {"metric": IG_VIEWS_METRIC, "period": "day",
                  "metric_type": "total_value", "since": failed, "until": end})
            config.setdefault("_warnings", []).append("Instagram views: returned no data")
        except ConnectorError as e:
            config.setdefault("_warnings", []).append(f"Instagram views: {e}")
    return out


def _instagram_rows(config, ig_id, start, end):
    series = _pull_daily(config, ig_id, IG_DAILY_METRICS, start, end)
    views = _ig_views_by_day(config, ig_id, start, end)
    if views:
        series["views"] = views
    followers = _pull_daily(config, ig_id, {"followers": IG_FOLLOWER_METRIC}, start, end)
    series.update(followers)
    rows = _rows_from_series(series, "Instagram",
                             ["views", "reach", "interactions", "link_clicks", "followers"])
    return _note_if_empty(config, rows, "Instagram")
