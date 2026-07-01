"""LinkedIn analytics parser.

Native LinkedIn export is XLSX with multiple sheets:
- "Followers"
- "Content" (post-level performance)
- "Visitors"

Also supports simple CSV format from the Google Form workflow for exec posts.
"""
from pathlib import Path
import pandas as pd


def parse_linkedin(path: Path) -> dict:
    result = {
        "followers": None,
        "follower_growth": None,
        "impressions": None,
        "engagements": None,
        "top_posts": [],
    }

    try:
        if path.suffix.lower() in [".xlsx", ".xls"]:
            sheets = pd.read_excel(path, sheet_name=None)
            result.update(_parse_native_export(sheets))
        else:
            df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
            result.update(_parse_generic(df))
    except Exception:
        pass

    return result


def _parse_native_export(sheets: dict) -> dict:
    out = {}

    # Followers sheet
    for name, df in sheets.items():
        if "follower" in name.lower():
            df.columns = [str(c).strip() for c in df.columns]
            total_col = _find_col(df, ["Total followers", "Followers"])
            gained_col = _find_col(df, ["New followers", "Followers gained"])
            if total_col:
                try:
                    out["followers"] = int(df[total_col].dropna().iloc[-1])
                except Exception:
                    pass
            if gained_col:
                try:
                    out["follower_growth"] = int(df[gained_col].dropna().sum())
                except Exception:
                    pass

    # Content sheet
    for name, df in sheets.items():
        if "content" in name.lower() or "post" in name.lower():
            df.columns = [str(c).strip() for c in df.columns]
            imp_col = _find_col(df, ["Impressions", "Views"])
            eng_col = _find_col(df, ["Engagements", "Reactions"])
            title_col = _find_col(df, ["Post title", "Title", "Post"])
            if imp_col:
                try:
                    out["impressions"] = int(df[imp_col].astype(float).sum())
                except Exception:
                    pass
            if eng_col:
                try:
                    out["engagements"] = int(df[eng_col].astype(float).sum())
                except Exception:
                    pass
            if title_col and imp_col:
                sub = df[[title_col, imp_col]].dropna().copy()
                sub[imp_col] = sub[imp_col].astype(float)
                top = sub.sort_values(imp_col, ascending=False).head(5)
                out["top_posts"] = [
                    {"title": str(r[title_col])[:100], "impressions": int(r[imp_col])}
                    for _, r in top.iterrows()
                ]
    return out


def _parse_generic(df) -> dict:
    df.columns = [str(c).strip() for c in df.columns]
    out = {}
    for col, key in [
        ("Followers", "followers"),
        ("Impressions", "impressions"),
        ("Engagements", "engagements"),
    ]:
        if col in df.columns:
            try:
                out[key] = int(df[col].astype(float).sum())
            except Exception:
                pass
    return out


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None
