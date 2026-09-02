"""Leads parser.

Feeds the "Leads" row of the at-a-glance strip. The CSV is deliberately
loose so it can come from wherever the tracking ends up living (GA4 key
events export, a form-plugin export, or a hand-kept sheet):

  leads_2026-09.csv with either
    - a single count column: leads / count / total / enquiries / conversions
    - or rows per source:    source, leads

With a source column the report can show where enquiries came from; without
one the month is just a total.
"""
from pathlib import Path

import pandas as pd

COUNT_COLS = ["leads", "count", "total", "enquiries", "conversions", "key_events"]


def parse_leads(path: Path) -> dict:
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    count_col = next((c for c in COUNT_COLS if c in df.columns), None)
    if not count_col:
        return {"total": None, "by_source": []}

    counts = pd.to_numeric(df[count_col], errors="coerce").fillna(0)
    total = int(counts.sum())

    source_col = next((c for c in ("source", "channel", "type") if c in df.columns), None)
    by_source = []
    if source_col:
        for _, r in df.iterrows():
            name = str(r[source_col]).strip()
            n = pd.to_numeric(pd.Series([r[count_col]]), errors="coerce").fillna(0).iloc[0]
            if name and name.lower() != "nan" and n:
                by_source.append({"source": name, "leads": int(n)})
        by_source.sort(key=lambda s: -s["leads"])

    return {"total": total, "by_source": by_source}
