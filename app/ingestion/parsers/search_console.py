"""Google Search Console CSV parser.

Handles the standard Queries or Pages export.
"""
from pathlib import Path
import pandas as pd


def parse_search_console(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip() for c in df.columns]

    clicks_col = _find_col(df, ["Clicks"])
    impressions_col = _find_col(df, ["Impressions"])
    ctr_col = _find_col(df, ["CTR"])
    position_col = _find_col(df, ["Position", "Average position"])

    total_clicks = _sum_num(df, clicks_col)
    total_impressions = _sum_num(df, impressions_col)
    avg_ctr = _avg_num(df, ctr_col) if ctr_col else (
        round(total_clicks / total_impressions * 100, 2) if total_clicks and total_impressions else None
    )
    avg_position = _avg_num(df, position_col)

    query_col = _find_col(df, ["Query", "Queries"])
    top_queries = []
    if query_col and clicks_col:
        sub = df[[query_col, clicks_col]].dropna().copy()
        sub[clicks_col] = sub[clicks_col].astype(str).str.replace(",", "").astype(float)
        top = sub.sort_values(clicks_col, ascending=False).head(10)
        top_queries = [
            {"query": r[query_col], "clicks": int(r[clicks_col])}
            for _, r in top.iterrows()
        ]

    return {
        "clicks": total_clicks,
        "impressions": total_impressions,
        "avg_ctr": avg_ctr,
        "avg_position": round(avg_position, 1) if avg_position else None,
        "top_queries": top_queries,
    }


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _sum_num(df, col):
    if not col or col not in df.columns:
        return None
    try:
        return int(df[col].astype(str).str.replace(",", "").astype(float).sum())
    except Exception:
        return None


def _avg_num(df, col):
    if not col or col not in df.columns:
        return None
    try:
        s = df[col].astype(str).str.replace("%", "").str.replace(",", "").astype(float)
        return float(s.mean())
    except Exception:
        return None
