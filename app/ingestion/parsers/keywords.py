"""Core keyword ranking parser.

CSV shape (written by the Ahrefs connector's Site Explorer sync, and equally
uploadable as an organic-keywords export):

  keyword, location, volume, position, position_prev

`location` is the market the position was read in - a two-letter country code
from the API, or whatever a hand-made export calls it.

`position` is this month's rank, `position_prev` last month's. Blank means
the keyword was not ranking in the tracked SERP that month, which is a real
state worth showing, not a gap to hide.

The report reads the rows for the core keyword table, and the highlights for
the "what moved this month" panel: keywords that broke into the top five (the
top three flagged), and the three that fell furthest.
"""
from pathlib import Path

import pandas as pd

# A keyword with no rank at all is treated as sitting just outside the tracked
# window when we measure how far it moved, so "fell out of the results" reads
# as a big drop rather than an unrankable blank.
UNRANKED = 101


def parse_core_keywords(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    kw_col = _col(df, ["keyword", "keywords"])
    if not kw_col:
        return _empty()

    pos_col = _col(df, ["position", "current_position", "rank"])
    prev_col = _col(df, ["position_prev", "previous_position", "position_last_month"])
    vol_col = _col(df, ["volume", "search_volume"])
    loc_col = _col(df, ["location", "country", "market"])

    rows = []
    for _, r in df.iterrows():
        keyword = str(r[kw_col]).strip()
        if not keyword or keyword.lower() == "nan":
            continue
        position = _int(r.get(pos_col)) if pos_col else None
        previous = _int(r.get(prev_col)) if prev_col else None
        rows.append({
            "keyword": keyword,
            "location": (str(r[loc_col]).strip() if loc_col and str(r[loc_col]).strip().lower() != "nan" else ""),
            "volume": _int(r.get(vol_col)) if vol_col else None,
            "position": position,
            "position_prev": previous,
            # Positive = climbed the page. None when there is nothing to
            # compare against (first month, or a keyword added mid-period).
            "change": (previous - position) if (position is not None and previous is not None) else None,
            "is_new": position is not None and previous is None,
        })

    if not rows:
        return _empty()

    ranked = [r for r in rows if r["position"] is not None]

    return {
        "rows": rows,
        "tracked": len(rows),
        "ranked": len(ranked),
        "top3": sum(1 for r in ranked if r["position"] <= 3),
        "top10": sum(1 for r in ranked if r["position"] <= 10),
        "improved": sum(1 for r in rows if (r["change"] or 0) > 0),
        "declined": sum(1 for r in rows if (r["change"] or 0) < 0),
        "avg_position": round(sum(r["position"] for r in ranked) / len(ranked), 1) if ranked else None,
        "gains": _gains(rows),
        "losses": _losses(rows),
    }


def _gains(rows: list) -> list:
    """Keywords that broke into the top five this month, best first."""
    out = [
        r for r in rows
        if r["position"] is not None and r["position"] <= 5
        and (r["position_prev"] is None or r["position_prev"] > 5)
    ]
    out.sort(key=lambda r: (r["position"], -(r["volume"] or 0)))
    return out[:5]


def _losses(rows: list) -> list:
    """The three keywords that fell furthest, biggest drop first."""
    out = []
    for r in rows:
        if r["position_prev"] is None:
            continue
        drop = (r["position"] if r["position"] is not None else UNRANKED) - r["position_prev"]
        if drop > 0:
            out.append({**r, "drop": drop, "lost_ranking": r["position"] is None})
    out.sort(key=lambda r: (-r["drop"], -(r["volume"] or 0)))
    return out[:3]


def _empty() -> dict:
    return {"rows": [], "tracked": 0, "ranked": 0, "top3": 0, "top10": 0,
            "improved": 0, "declined": 0, "avg_position": None,
            "gains": [], "losses": []}


def _col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _int(v):
    try:
        if v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == "":
            return None
        return int(float(v))
    except (ValueError, TypeError):
        return None
