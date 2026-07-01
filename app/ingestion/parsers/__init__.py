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
