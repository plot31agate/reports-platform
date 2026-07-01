"""Technical SEO parsers.

Two files expected per period:
  technical_seo_metrics.csv  — one row per month, append-only
  technical_seo_register.csv — one row per issue, carried forward and updated

Both are identified by filename prefix via PARSER_MAP; the builder combines
them and computes month-over-month deltas.
"""
from pathlib import Path

import pandas as pd


_METRICS_COLS = {
    "month", "health_score", "high_open", "medium_open", "low_open",
    "total_open", "confirmed", "verify", "action",
    "resolved_this_month", "new_this_month", "domain_rating",
}

_REGISTER_COLS = {
    "issue_id", "first_seen", "category", "finding",
    "severity", "status", "recommendation",
}


def parse_technical_seo_metrics(path: Path) -> list:
    """Return list of metric dicts sorted by month ascending."""
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    missing = _METRICS_COLS - set(df.columns)
    if missing:
        raise ValueError(f"technical_seo_metrics missing columns: {sorted(missing)}")

    rows = []
    for _, r in df.iterrows():
        try:
            rows.append({
                "month":               str(r["month"]).strip(),
                "health_score":        int(r["health_score"]),
                "high_open":           int(r["high_open"]),
                "medium_open":         int(r["medium_open"]),
                "low_open":            int(r["low_open"]),
                "total_open":          int(r["total_open"]),
                "confirmed":           int(r["confirmed"]),
                "verify":              int(r["verify"]),
                "action":              int(r["action"]),
                "resolved_this_month": int(r["resolved_this_month"]),
                "new_this_month":      int(r["new_this_month"]),
                "domain_rating":       int(r["domain_rating"]),
                "note":                str(r.get("note", "") or "").strip(),
            })
        except (ValueError, KeyError):
            continue

    rows.sort(key=lambda x: x["month"])
    return rows


def parse_technical_seo_register(path: Path) -> list:
    """Return list of issue dicts from the register CSV."""
    df = pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    missing = _REGISTER_COLS - set(df.columns)
    if missing:
        raise ValueError(f"technical_seo_register missing columns: {sorted(missing)}")

    issues = []
    for _, r in df.iterrows():
        resolved = str(r.get("resolved_month", "") or "").strip()
        issues.append({
            "issue_id":       str(r.get("issue_id", "")).strip(),
            "first_seen":     str(r.get("first_seen", "")).strip(),
            "category":       str(r.get("category", "")).strip(),
            "finding":        str(r.get("finding", "")).strip(),
            "severity":       str(r.get("severity", "")).strip(),
            "status":         str(r.get("status", "")).strip(),
            "affected_scope": str(r.get("affected_scope", "")).strip(),
            "recommendation": str(r.get("recommendation", "")).strip(),
            "effort":         str(r.get("effort", "")).strip(),
            "timeframe":      str(r.get("timeframe", "")).strip(),
            "owner":          str(r.get("owner", "")).strip(),
            "resolved_month": resolved if resolved not in ("", "nan") else "",
        })
    return issues
