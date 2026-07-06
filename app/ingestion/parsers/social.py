"""Social channel parsers — Facebook & Instagram (Meta), TikTok, influencers.

Meta and TikTok have no agency-key API (Meta needs a per-page access token,
TikTok an approved developer app), so these stay uploads: export from Meta
Business Suite / TikTok analytics, or hand-build the CSV. Column matching is
forgiving — see the candidate lists below.
"""
from pathlib import Path
import pandas as pd


def _read_table(path: Path):
    try:
        if path.suffix.lower() in (".xlsx", ".xls"):
            df = pd.read_excel(path)
        else:
            df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    except Exception:
        return None
    if df is None or df.empty:
        return None
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _find_col(df, candidates):
    lower = {c.lower(): c for c in df.columns}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def _num(val):
    try:
        return float(str(val).replace(",", "").replace("%", "").strip())
    except (ValueError, TypeError):
        return None


def _sum(df, col):
    if not col:
        return None
    total = df[col].map(_num).dropna().sum()
    return int(total) if pd.notna(total) else None


def _top_day(df, date_col, value_col):
    """Peak day for a metric — the 'spike on 20 June' line in the report."""
    if not date_col or not value_col:
        return None
    sub = df[[date_col, value_col]].copy()
    sub[value_col] = sub[value_col].map(_num)
    sub = sub.dropna()
    if sub.empty:
        return None
    daily = sub.groupby(date_col)[value_col].sum()
    if len(daily) < 2:
        return None
    best = daily.idxmax()
    return {"date": str(best)[:10], "value": int(daily[best])}


def parse_meta_social(path: Path) -> dict:
    """Facebook & Instagram results, one or both platforms in one file.

    Expected columns: Platform (facebook/instagram) + any of Views, Reach,
    Content interactions, Link clicks, Followers. A Date column enables
    peak-day detection. Without a Platform column the file is treated as a
    single combined channel.
    """
    df = _read_table(path)
    if df is None:
        return {"platforms": [], "total_views": None}

    platform_col = _find_col(df, ["Platform", "Channel", "Network", "Account"])
    date_col = _find_col(df, ["Date", "Day"])
    metric_cols = {
        "views": _find_col(df, ["Views", "Video views", "Impressions"]),
        "reach": _find_col(df, ["Reach", "Viewers", "Accounts reached", "Accounts Center accounts reached"]),
        "interactions": _find_col(df, ["Content interactions", "Interactions", "Engagements", "Engagement"]),
        "link_clicks": _find_col(df, ["Link clicks", "Clicks", "Website clicks"]),
        "followers": _find_col(df, ["Followers", "Net follows", "New followers", "Follows"]),
    }

    def build(sub, name):
        row = {"platform": name}
        for key, col in metric_cols.items():
            row[key] = _sum(sub, col)
        row["top_day"] = _top_day(sub, date_col, metric_cols["views"])
        return row

    platforms = []
    if platform_col:
        for name, sub in df.groupby(df[platform_col].astype(str).str.strip().str.title()):
            if name and name.lower() != "nan":
                platforms.append(build(sub, name))
        platforms.sort(key=lambda p: -(p.get("views") or 0))
    else:
        platforms.append(build(df, "Facebook & Instagram"))

    def views_of(name):
        hit = next((p for p in platforms if name in p["platform"].lower()), None)
        return hit.get("views") if hit else None

    return {
        "platforms": platforms,
        "fb_views": views_of("facebook"),
        "ig_views": views_of("instagram"),
        "total_views": sum(p.get("views") or 0 for p in platforms) or None,
    }


def parse_tiktok(path: Path) -> dict:
    """TikTok totals. Columns: Views/Video views, Likes, Comments, Shares,
    optional Followers and Date (for peak-day detection)."""
    df = _read_table(path)
    if df is None:
        return {"views": None}

    date_col = _find_col(df, ["Date", "Day"])
    cols = {
        "views": _find_col(df, ["Video views", "Views", "Post views"]),
        "likes": _find_col(df, ["Likes"]),
        "comments": _find_col(df, ["Comments"]),
        "shares": _find_col(df, ["Shares"]),
        "followers": _find_col(df, ["Followers", "Net followers", "New followers"]),
    }
    out = {key: _sum(df, col) for key, col in cols.items()}
    out["top_day"] = _top_day(df, date_col, cols["views"])
    return out


def parse_influencers(path: Path) -> dict:
    """Influencer/creator activity as a table. Columns: Influencer/Creator,
    Platform, Content/Post, Reach/Views, Engagements, Link."""
    df = _read_table(path)
    if df is None:
        return {"rows": []}

    name_col = _find_col(df, ["Influencer", "Creator", "Name", "Handle", "Account"])
    if not name_col:
        return {"rows": []}
    platform_col = _find_col(df, ["Platform", "Channel", "Network"])
    content_col = _find_col(df, ["Content", "Post", "Description", "Title", "Activity"])
    reach_col = _find_col(df, ["Reach", "Views", "Impressions"])
    engage_col = _find_col(df, ["Engagements", "Engagement", "Interactions", "Content interactions"])
    link_col = _find_col(df, ["Link", "URL", "Post link"])

    rows = []
    for _, r in df.iterrows():
        name = str(r.get(name_col) or "").strip()
        if not name or name.lower() == "nan":
            continue
        reach = _num(r.get(reach_col)) if reach_col else None
        engage = _num(r.get(engage_col)) if engage_col else None
        rows.append({
            "name": name,
            "platform": (str(r.get(platform_col)).strip() if platform_col and pd.notna(r.get(platform_col)) else ""),
            "content": (str(r.get(content_col)).strip() if content_col and pd.notna(r.get(content_col)) else ""),
            "reach": int(reach) if reach is not None else None,
            "engagements": int(engage) if engage is not None else None,
            "link": (str(r.get(link_col)).strip() if link_col and pd.notna(r.get(link_col)) else ""),
        })
    rows.sort(key=lambda x: -(x.get("reach") or 0))

    return {
        "rows": rows,
        "total_reach": sum(r["reach"] or 0 for r in rows) or None,
    }
