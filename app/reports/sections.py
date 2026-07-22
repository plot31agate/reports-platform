"""Report section registry — which sections a client's report includes.

Each section groups one or more data sources. A client's config_json can
carry a "sections" list of section keys; a missing or empty list means the
default set (the original report shape), so existing clients are untouched.

The workspace "Report sections" panel writes the list; the workspace source
grid and the report template both read it.
"""

SECTION_DEFS = [
    {"key": "media",         "label": "Media coverage & sentiment", "sources": ["mentions"],                                        "default": True,
     "hint": "Earned coverage, sentiment, executive visibility"},
    {"key": "sov",           "label": "Share of voice",             "sources": ["competitor_benchmark"],                            "default": True,
     "hint": "Organic search share vs competitors"},
    {"key": "traffic",       "label": "Search & site traffic",      "sources": ["ga4_export", "search_console", "core_keywords"],    "default": True,
     "hint": "GA4 users, sessions, engagement; Search Console; core keyword rankings"},
    {"key": "geography",     "label": "Geography",                  "sources": ["ga4_geography"],                                   "default": True,
     "hint": "Visits by country"},
    {"key": "links",         "label": "Authority & backlinks",      "sources": ["ahrefs_backlinks", "ahrefs_trends"],               "default": True,
     "hint": "Domain rating, referring domains, 12-month trends"},
    {"key": "linkedin",      "label": "LinkedIn",                   "sources": ["linkedin_company"],                                "default": True,
     "hint": "Followers, impressions, top posts"},
    {"key": "social",        "label": "Facebook & Instagram",       "sources": ["meta_social"],                                     "default": False,
     "hint": "Views, reach, interactions, link clicks per platform"},
    {"key": "tiktok",        "label": "TikTok",                     "sources": ["tiktok"],                                          "default": False,
     "hint": "Views, likes, comments, shares"},
    {"key": "influencers",   "label": "Influencer activity",        "sources": ["influencer_activity"],                             "default": False,
     "hint": "Creator posts with reach and engagement"},
    {"key": "technical_seo", "label": "Technical SEO",              "sources": ["technical_seo_metrics", "technical_seo_register"], "default": True,
     "hint": "Site health score and issue register"},
    {"key": "misc",          "label": "Misc (custom section)",      "sources": [],                                                  "default": False,
     "hint": "A free-text section you write on the review screen"},
]

DEFAULT_SECTIONS = [d["key"] for d in SECTION_DEFS if d["default"]]
ALL_SECTION_KEYS = [d["key"] for d in SECTION_DEFS]


def enabled_sections(client_config: dict) -> list:
    saved = client_config.get("sections")
    if isinstance(saved, list) and saved:
        return [k for k in ALL_SECTION_KEYS if k in saved]
    return list(DEFAULT_SECTIONS)


def enabled_source_keys(client_config: dict) -> set:
    enabled = set(enabled_sections(client_config))
    keys = set()
    for d in SECTION_DEFS:
        if d["key"] in enabled:
            keys.update(d["sources"])
    return keys
