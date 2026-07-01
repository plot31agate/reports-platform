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


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None
