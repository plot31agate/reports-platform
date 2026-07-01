"""Parser registry.

Each parser: takes a CSV path, returns a normalised dict for the report builder.
Missing files return an empty structure so the report still renders.
"""
from pathlib import Path

from app.ingestion.parsers.ahrefs import parse_ahrefs
from app.ingestion.parsers.similarweb import parse_similarweb
from app.ingestion.parsers.ga4 import parse_ga4
from app.ingestion.parsers.search_console import parse_search_console
from app.ingestion.parsers.linkedin import parse_linkedin
from app.ingestion.parsers.mentions import parse_mentions
from app.ingestion.parsers.technical_seo import (
    parse_technical_seo_metrics,
    parse_technical_seo_register,
)


PARSER_MAP = {
    "ahrefs_backlinks":        ("Ahrefs backlinks",            parse_ahrefs),
    "similarweb_traffic":      ("Similarweb traffic",          parse_similarweb),
    "ga4_export":              ("GA4 export",                  parse_ga4),
    "search_console":          ("Search Console",              parse_search_console),
    "linkedin_company":        ("LinkedIn (company)",          parse_linkedin),
    "mentions":                ("Media mentions",              parse_mentions),
    "technical_seo_metrics":   ("Technical SEO metrics",       parse_technical_seo_metrics),
    "technical_seo_register":  ("Technical SEO issue register",parse_technical_seo_register),
}


# Source definitions — drives the upload UI cards
SOURCE_DEFS = [
    {"key": "mentions",               "title": "Media mentions",        "purpose": "Coverage, sentiment, exec mentions",          "cols": "title, url, source, date"},
    {"key": "ga4_export",             "title": "GA4",                   "purpose": "Sessions, users, top pages",                  "cols": "sessions, users, pagePath"},
    {"key": "search_console",         "title": "Search Console",        "purpose": "Clicks, impressions, CTR, position",          "cols": "query, clicks, impressions, ctr"},
    {"key": "ahrefs_backlinks",       "title": "Ahrefs backlinks",      "purpose": "Referring domains, backlink growth",          "cols": "referring_domain, domain_rating"},
    {"key": "similarweb_traffic",     "title": "Similarweb",            "purpose": "Traffic and channel mix",                    "cols": "date, visits, channel, share"},
    {"key": "linkedin_company",       "title": "LinkedIn (company)",    "purpose": "Impressions, followers, top posts",           "cols": "date, impressions, clicks, followers"},
    {"key": "technical_seo_metrics",  "title": "Technical SEO metrics", "purpose": "Site health score, DR, open issues by month", "cols": "month, health_score, domain_rating, total_open"},
    {"key": "technical_seo_register", "title": "Technical SEO register","purpose": "Issue register with severity and status",     "cols": "issue_id, finding, severity, status"},
]


def summarise_parsed(source_key: str, data) -> dict:
    """Return {status, summary, warnings, row_count} for the upload card UI."""
    warnings = []

    if source_key == "mentions":
        total = (data or {}).get("total", 0)
        deduped = (data or {}).get("deduped_count", 0)
        s = f"{total} mention{'s' if total != 1 else ''}"
        if deduped:
            s += f" ({deduped} duplicate{'s' if deduped != 1 else ''} removed)"
        return {"status": "ok" if total > 0 else "warning", "summary": s,
                "warnings": [] if total > 0 else ["No mentions found - check column names are: title, url, source, date"],
                "row_count": total}

    if source_key == "ga4_export":
        sessions = (data or {}).get("sessions") or 0
        users = (data or {}).get("users") or 0
        engaged = (data or {}).get("engaged_sessions") or 0
        sources = len((data or {}).get("top_sources", []))
        if sessions > 0 and users == 0:
            warnings.append(f"Users is 0 while sessions is {sessions:,} - export may not include a users column")
        parts = [f"{sessions:,} sessions"]
        if users:
            parts.append(f"{users:,} users")
        if engaged:
            parts.append(f"{engaged:,} engaged")
        if sources:
            parts.append(f"{sources} channels")
        return {"status": "warning" if warnings else "ok", "summary": ", ".join(parts),
                "warnings": warnings, "row_count": sessions}

    if source_key == "search_console":
        clicks = (data or {}).get("clicks") or 0
        impressions = (data or {}).get("impressions") or 0
        queries = len((data or {}).get("top_queries", []))
        ctr = (data or {}).get("avg_ctr")
        s = f"{clicks:,} clicks, {impressions:,} impressions"
        if ctr:
            s += f", {ctr:.1f}% avg CTR"
        if queries:
            s += f", {queries} top queries"
        return {"status": "ok" if clicks > 0 or impressions > 0 else "warning",
                "summary": s, "warnings": [], "row_count": clicks}

    if source_key == "ahrefs_backlinks":
        rd = (data or {}).get("referring_domains") or 0
        bl = (data or {}).get("total_backlinks") or 0
        dr = (data or {}).get("avg_referring_dr")
        s = f"{rd:,} referring domains, {bl:,} backlinks"
        if dr:
            s += f", avg DR {dr}"
        return {"status": "ok" if rd > 0 else "warning", "summary": s,
                "warnings": [] if rd > 0 else ["No referring domains found - check column names"],
                "row_count": rd}

    if source_key == "similarweb_traffic":
        visits = (data or {}).get("total_visits") or 0
        countries = len((data or {}).get("top_countries", []))
        s = f"{visits:,} total visits"
        if countries:
            s += f", {countries} countries"
        return {"status": "ok" if visits > 0 else "warning", "summary": s,
                "warnings": [], "row_count": visits}

    if source_key == "linkedin_company":
        followers = (data or {}).get("followers") or 0
        impressions = (data or {}).get("impressions") or 0
        s = f"{followers:,} followers, {impressions:,} impressions"
        return {"status": "ok" if followers > 0 else "warning", "summary": s,
                "warnings": [], "row_count": followers}

    if source_key == "technical_seo_metrics":
        rows = data if isinstance(data, list) else []
        if not rows:
            return {"status": "error", "summary": "No metric rows found", "warnings": [], "row_count": 0}
        latest = rows[-1]
        s = f"Health {latest.get('health_score', '?')}/100, DR {latest.get('domain_rating', '?')}, {latest.get('total_open', '?')} open issues"
        return {"status": "ok", "summary": s, "warnings": [], "row_count": len(rows)}

    if source_key == "technical_seo_register":
        rows = data if isinstance(data, list) else []
        open_issues = [r for r in rows if not r.get("resolved_month")]
        sev = {"High": 0, "Medium": 0, "Low": 0}
        for r in open_issues:
            sev[r.get("severity", "Low")] = sev.get(r.get("severity", "Low"), 0) + 1
        s = f"{len(rows)} issues ({len(open_issues)} open: {sev['High']}H {sev['Medium']}M {sev['Low']}L)"
        return {"status": "ok", "summary": s, "warnings": [], "row_count": len(rows)}

    # Fallback
    return {"status": "ok", "summary": "Parsed", "warnings": [], "row_count": 0}


def parse_all(data_dir: Path) -> dict:
    """Run every parser against files in data_dir. Returns dict keyed by parser name."""
    out = {}
    for key, (label, parser) in PARSER_MAP.items():
        # Look for files matching pattern e.g. ahrefs_backlinks*.csv or *.xlsx
        matches = list(data_dir.glob(f"{key}*")) + list(data_dir.glob(f"*{key}*"))
        matches = [m for m in matches if m.is_file()]
        if matches:
            try:
                out[key] = {"label": label, "data": parser(matches[0]), "source_file": matches[0].name}
            except Exception as e:
                out[key] = {"label": label, "data": None, "error": str(e), "source_file": matches[0].name}
        else:
            out[key] = {"label": label, "data": None, "source_file": None}
    return out
