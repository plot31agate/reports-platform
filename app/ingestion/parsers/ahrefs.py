"""Ahrefs backlinks CSV parser.

Expected columns (typical Ahrefs backlinks export):
  Referring page URL, Referring page title, Domain rating,
  UR, External links, Anchor, Type, Target URL, First seen, Last check
"""
from pathlib import Path
import pandas as pd


def parse_ahrefs(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    # Normalise column names (Ahrefs uses various spacings)
    df.columns = [c.strip() for c in df.columns]

    total_backlinks = len(df)

    # Referring domains: unique domain part of Referring page URL
    ref_col = _find_col(df, ["Referring page URL", "Referring URL", "URL from"])
    if ref_col:
        df["_domain"] = df[ref_col].astype(str).str.extract(
            r"https?://([^/]+)/", expand=False
        ).str.replace(r"^www\.", "", regex=True)
        referring_domains = df["_domain"].dropna().nunique()
        top_domains = (
            df["_domain"].value_counts().head(10)
            .rename_axis("domain").reset_index(name="backlinks")
            .to_dict(orient="records")
        )
    else:
        referring_domains = 0
        top_domains = []

    dr_col = _find_col(df, ["Domain rating", "DR"])
    avg_dr = float(df[dr_col].dropna().astype(float).mean()) if dr_col else None

    return {
        "total_backlinks": total_backlinks,
        "referring_domains": referring_domains,
        "avg_referring_dr": round(avg_dr, 1) if avg_dr else None,
        "top_referring_domains": top_domains,
    }


def parse_ahrefs_trends(path: Path) -> dict:
    """12-month history CSV (month, domain_rating, referring_domains,
    organic_traffic) -> points + latest values + MoM deltas + per-metric max,
    ready for the report's trend sparklines."""
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower() for c in df.columns]
    if "month" not in df.columns:
        return {"points": [], "latest": None, "deltas": {}, "max": {}}

    metrics = ["domain_rating", "referring_domains", "organic_traffic"]
    points = []
    for _, r in df.iterrows():
        point = {"month": str(r["month"]).strip()}
        for m in metrics:
            try:
                v = float(r[m])
                point[m] = round(v, 1) if m == "domain_rating" else int(v)
            except (ValueError, TypeError, KeyError):
                point[m] = None
        if point["month"]:
            points.append(point)
    points.sort(key=lambda p: p["month"])

    latest = points[-1] if points else None
    prev = points[-2] if len(points) > 1 else None
    deltas = {}
    if latest and prev:
        for m in metrics:
            if latest.get(m) is not None and prev.get(m) is not None:
                d = latest[m] - prev[m]
                deltas[m] = round(d, 1) if m == "domain_rating" else int(d)

    maxes = {
        m: max((p[m] for p in points if p.get(m) is not None), default=0) or 1
        for m in metrics
    }
    return {"points": points, "latest": latest, "deltas": deltas, "max": maxes}


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None
