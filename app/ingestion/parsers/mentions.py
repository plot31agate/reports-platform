"""Media mentions CSV parser.

Expected columns: date, source, title, url, snippet.
Very forgiving — extracts what it can, leaves the rest.
Feeds directly into sentiment.py.
"""
from pathlib import Path
import pandas as pd


def parse_mentions(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower() for c in df.columns]

    # Standardise column names
    col_map = {}
    for wanted, alternatives in {
        "date":    ["date", "published", "published_at", "publish_date"],
        "source":  ["source", "publication", "site", "domain"],
        "title":   ["title", "headline", "post title"],
        "url":     ["url", "link", "article url"],
        "snippet": ["snippet", "summary", "description", "excerpt"],
    }.items():
        for alt in alternatives:
            if alt in df.columns:
                col_map[wanted] = alt
                break

    if "title" not in col_map and "url" not in col_map:
        return {"total": 0, "mentions": [], "top_sources": []}

    mentions = []
    for _, row in df.iterrows():
        m = {}
        for k, src_col in col_map.items():
            v = row.get(src_col)
            m[k] = str(v) if pd.notna(v) else ""
        if m.get("title") or m.get("url"):
            mentions.append(m)

    top_sources = []
    if "source" in col_map:
        counts = df[col_map["source"]].dropna().value_counts().head(10)
        top_sources = [{"source": s, "count": int(c)} for s, c in counts.items()]

    return {
        "total": len(mentions),
        "mentions": mentions,
        "top_sources": top_sources,
    }
