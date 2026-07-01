"""Similarweb traffic CSV parser.

Expected format: monthly visits, sources breakdown, geo split.
Similarweb exports vary — this handles the standard "Traffic overview"
and "Countries" exports. Extend as needed.
"""
from pathlib import Path
import pandas as pd


def parse_similarweb(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip() for c in df.columns]

    result = {
        "total_visits": None,
        "traffic_sources": {},
        "top_countries": [],
    }

    # Total visits
    visits_col = _find_col(df, ["Visits", "Total Visits", "Monthly Visits"])
    if visits_col:
        val = df[visits_col].dropna().iloc[0] if not df[visits_col].dropna().empty else None
        result["total_visits"] = _to_number(val)

    # Country breakdown
    country_col = _find_col(df, ["Country", "Countries"])
    share_col = _find_col(df, ["Share", "Traffic Share", "Percentage"])
    if country_col and share_col:
        top = (
            df[[country_col, share_col]]
            .dropna()
            .head(10)
            .to_dict(orient="records")
        )
        result["top_countries"] = [
            {"country": r[country_col], "share": _to_percent(r[share_col])} for r in top
        ]

    # Traffic sources: look for columns named Direct/Search/Social/etc.
    for src in ["Direct", "Search", "Social", "Referrals", "Mail", "Display"]:
        if src in df.columns:
            val = df[src].dropna().iloc[0] if not df[src].dropna().empty else None
            if val is not None:
                result["traffic_sources"][src.lower()] = _to_percent(val)

    return result


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _to_number(v):
    try:
        s = str(v).replace(",", "").replace(" ", "")
        return int(float(s))
    except (ValueError, TypeError):
        return None


def _to_percent(v):
    try:
        s = str(v).replace("%", "").strip()
        f = float(s)
        return round(f, 1)
    except (ValueError, TypeError):
        return None
