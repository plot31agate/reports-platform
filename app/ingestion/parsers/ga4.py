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

    total_users = _sum_col(df, users_col)
    total_sessions = _sum_col(df, sessions_col)
    total_engaged = _sum_col(df, engaged_col)

    top_pages = _top_by(df, ["Page path", "Page path and screen class", "Page title and screen class"], users_col or sessions_col, 10)
    top_sources = _top_by(df, [
        "Session primary channel group (Default Channel Group)",
        "Session source / medium", "Session source",
        "First user primary channel group (Default Channel Group)",
        "First user source", "Source",
    ], sessions_col or users_col, 10)

    return {
        "users": total_users,
        "sessions": total_sessions,
        "engaged_sessions": total_engaged,
        "top_pages": top_pages,
        "top_sources": top_sources,
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
