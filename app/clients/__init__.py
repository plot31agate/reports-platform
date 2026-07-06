"""Client registry.

The DB `clients` table is the single source of truth at runtime — every
client (whether added in-app or seeded from code) lives there, and its
config_json is merged onto DEFAULT_CLIENT below.

Code modules (like sportingtech.py) are seed data only: init_db copies them
into the DB on first boot, after which edits belong in the DB.
"""
import json

from app.clients.sportingtech import SPORTINGTECH


# Seed registry — consumed by init_db, not used for runtime lookups.
CLIENTS = {
    "sportingtech": SPORTINGTECH,
}


# Default brand + context applied to any DB-defined client, overridden by config_json.
DEFAULT_CLIENT = {
    "brandline": "",
    "tagline": "",
    "colours": {
        "coral": "#FF4F40",
        "teal": "#00D8AE",
        "black": "#000000",
        "white": "#FFFFFF",
        "lime": "#B6EC2D",
        "blue": "#0069C4",
        "hero": "#FF4F40",
        "accent": "#00D8AE",
    },
    "font_stack": "'Aptos', 'Inter', system-ui, -apple-system, sans-serif",
    "executives": [],
    "competitors": [],
    "regions_of_interest": [],
    "mention_feeds": [],
    # Report sections: None/empty = the default set (see app/reports/sections.py).
    # The workspace "Report sections" panel writes a list of section keys here.
    "sections": None,
    "misc_title": "",
    "sentiment_context": (
        "You are analysing media mentions of this brand. Score sentiment from the "
        "brand's commercial perspective: launches, market entries, partnerships and "
        "executive hires are POSITIVE; competitor wins and losses are NEGATIVE; "
        "generic industry commentary is NEUTRAL."
    ),
}


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


def get_client(slug: str) -> dict:
    from app.db import get_client_row

    row = get_client_row(slug)
    if not row:
        # Not yet seeded (e.g. before first init_db run) — fall back to code.
        if slug in CLIENTS:
            return CLIENTS[slug]
        raise KeyError(f"Unknown client: {slug}")

    cfg = {}
    if row.get("config_json"):
        try:
            cfg = json.loads(row["config_json"])
        except (ValueError, TypeError):
            cfg = {}

    # Code seeds act as per-client defaults under the DB config, so a field
    # added to a seed module after first boot still shows through until it
    # is overridden in the DB.
    merged = _merge(_merge(DEFAULT_CLIENT, CLIENTS.get(slug) or {}), cfg)
    merged["slug"] = slug
    merged["display_name"] = row["display_name"]
    # hero/accent mirror the primary colours unless explicitly set
    merged["colours"]["hero"] = merged["colours"].get("hero") or merged["colours"]["coral"]
    merged["colours"]["accent"] = merged["colours"].get("accent") or merged["colours"]["teal"]
    return merged
