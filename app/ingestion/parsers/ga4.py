"""GA4 CSV parser.

Handles standard GA4 UI exports (Reports > Acquisition, etc.).
GA4 exports are messy: usually 8 header rows of metadata then column names.
"""
from pathlib import Path
import pandas as pd


def parse_ga4(path: Path) -> dict:
    # GA4 exports typically have preamble rows before the actual data
    df = _read_ga4_csv(path)
    if df is None or df.empty:
        return {"users": None, "sessions": None, "top_pages": [], "top_sources": []}

    df.columns = [c.strip() for c in df.columns]

    users_col = _find_col(df, ["Users", "Total users", "Active users"])
    sessions_col = _find_col(df, ["Sessions"])
    engaged_col = _find_col(df, ["Engaged sessions"])
    new_users_col = _find_col(df, ["New users"])
    duration_col = _find_col(df, ["User engagement duration", "Engagement duration"])

    total_users = _sum_col(df, users_col)
    total_sessions = _sum_col(df, sessions_col)
    total_engaged = _sum_col(df, engaged_col)
    total_new_users = _sum_col(df, new_users_col)
    total_duration = _sum_col(df, duration_col)

    # Average engagement time per session, from the total-duration column the
    # API sync writes (UI exports carry per-row averages, which don't sum).
    avg_engagement_secs = None
    if total_duration and total_sessions:
        avg_engagement_secs = round(total_duration / total_sessions)

    top_pages = _top_by(df, ["Page path", "Page path and screen class", "Page title and screen class"], users_col or sessions_col, 10)
    channel_col = _find_col(df, [
        "Session primary channel group (Default Channel Group)",
        "Session source / medium", "Session source",
        "First user primary channel group (Default Channel Group)",
        "First user source", "Source",
    ])
    top_sources = _top_by(df, [channel_col] if channel_col else [], sessions_col or users_col, 10)

    return {
        "users": total_users,
        "sessions": total_sessions,
        "engaged_sessions": total_engaged,
        "new_users": total_new_users,
        "avg_engagement_secs": avg_engagement_secs,
        "top_pages": top_pages,
        "top_sources": top_sources,
        "channels": _channel_detail(df, channel_col, sessions_col, engaged_col, new_users_col, duration_col),
    }


def _channel_detail(df, channel_col, sessions_col, engaged_col, new_users_col, duration_col):
    """Per-channel engagement table: sessions, new users, engagement rate,
    average engagement time. Only rendered when the richer columns exist."""
    if not channel_col or not sessions_col:
        return []
    cols = [c for c in [channel_col, sessions_col, engaged_col, new_users_col, duration_col] if c]
    try:
        sub = df[cols].dropna(subset=[channel_col]).copy()
        for c in cols[1:]:
            sub[c] = sub[c].astype(str).str.replace(",", "").astype(float)
        grouped = sub.groupby(channel_col).sum().sort_values(sessions_col, ascending=False)
    except Exception:
        return []
    out = []
    for name, r in grouped.head(8).iterrows():
        sessions = r.get(sessions_col) or 0
        if not str(name).strip() or not sessions:
            continue
        row = {"channel": str(name).strip(), "sessions": int(sessions), "new_users": None,
               "engagement_rate": None, "avg_engagement_secs": None}
        if new_users_col:
            row["new_users"] = int(r.get(new_users_col) or 0)
        if engaged_col:
            row["engagement_rate"] = round((r.get(engaged_col) or 0) / sessions * 100, 1)
        if duration_col:
            row["avg_engagement_secs"] = round((r.get(duration_col) or 0) / sessions)
        out.append(row)
    # Rate and time need the richer columns; a bare channel/sessions table
    # already renders as top_sources, so skip the duplicate.
    if not (engaged_col or duration_col or new_users_col):
        return []
    return out


def parse_ga4_geography(path: Path) -> dict:
    """Sessions by country — from the API sync or a GA4 UI countries export.

    Expected columns: Country + Sessions (or Active users / Users).
    Returns the same shape the Geography report section renders:
    {top_countries: [{country, share}], total_visits}.
    """
    df = _read_ga4_csv(path)
    if df is None or df.empty:
        return {"top_countries": [], "total_visits": None}
    df.columns = [c.strip() for c in df.columns]

    country_col = _find_col(df, ["Country", "Country ID"])
    value_col = _find_col(df, ["Sessions", "Active users", "Users", "Total users"])
    if not country_col or not value_col:
        return {"top_countries": [], "total_visits": None}

    sub = df[[country_col, value_col]].dropna().copy()
    sub[value_col] = sub[value_col].astype(str).str.replace(",", "").astype(float)
    sub = sub[sub[country_col].astype(str).str.strip().ne("")]
    total = float(sub[value_col].sum())
    top = sub.sort_values(value_col, ascending=False).head(10)

    return {
        "top_countries": [
            {"country": r[country_col], "share": round(r[value_col] / total * 100, 1) if total else 0}
            for _, r in top.iterrows()
        ],
        "total_visits": int(total) if total else None,
    }


def _read_ga4_csv(path: Path):
    """Try reading GA4 CSV with various skip-row counts."""
    for skip in [0, 6, 7, 8, 9, 10]:
        try:
            df = pd.read_csv(path, encoding="utf-8", skiprows=skip, on_bad_lines="skip")
            # Heuristic: if we got sensible columns, we're good
            if any(c in df.columns for c in [
                "Users", "Sessions", "Page path", "Session source",
                "Session primary channel group (Default Channel Group)",
                "First user primary channel group (Default Channel Group)",
                "Page title and screen class",
                "Country",
            ]):
                return df
        except Exception:
            continue
    return None


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _sum_col(df, col):
    if not col or col not in df.columns:
        return None
    try:
        return int(df[col].astype(str).str.replace(",", "").astype(float).sum())
    except Exception:
        return None


def _top_by(df, name_candidates, value_col, n):
    name_col = _find_col(df, name_candidates)
    if not name_col or not value_col or value_col not in df.columns:
        return []
    try:
        sub = df[[name_col, value_col]].dropna().copy()
        sub[value_col] = sub[value_col].astype(str).str.replace(",", "").astype(float)
        top = sub.sort_values(value_col, ascending=False).head(n)
        return [
            {"name": r[name_col], "value": int(r[value_col])}
            for _, r in top.iterrows()
        ]
    except Exception:
        return []
