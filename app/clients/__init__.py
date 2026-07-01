"""Client registry.

Clients come from two places:
  1. Code modules (rich, hand-tuned configs like Sportingtech).
  2. The DB `clients` table (created in-app via the New client flow),
     whose config_json is merged onto a sensible default template.
"""
import json

from app.clients.sportingtech import SPORTINGTECH


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
    if slug in CLIENTS:
        return CLIENTS[slug]

    # Fall back to a DB-defined client.
    from app.db import get_client_row

    row = get_client_row(slug)
    if not row:
        raise KeyError(f"Unknown client: {slug}")

    cfg = {}
    if row.get("config_json"):
        try:
            cfg = json.loads(row["config_json"])
        except (ValueError, TypeError):
            cfg = {}

    merged = _merge(DEFAULT_CLIENT, cfg)
    merged["slug"] = slug
    merged["display_name"] = row["display_name"]
    # hero/accent mirror the primary colours unless explicitly set
    merged["colours"]["hero"] = merged["colours"].get("hero") or merged["colours"]["coral"]
    merged["colours"]["accent"] = merged["colours"].get("accent") or merged["colours"]["teal"]
    return merged
