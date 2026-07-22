"""Parser registry.

Each parser: takes a CSV path, returns a normalised dict for the report builder.
Missing files return an empty structure so the report still renders.
"""
from pathlib import Path

from app.ingestion.parsers.ahrefs import parse_ahrefs, parse_ahrefs_trends, parse_competitor_benchmark
from app.ingestion.parsers.similarweb import parse_similarweb
from app.ingestion.parsers.ga4 import parse_ga4, parse_ga4_geography
from app.ingestion.parsers.search_console import parse_search_console
from app.ingestion.parsers.keywords import parse_core_keywords
from app.ingestion.parsers.linkedin import parse_linkedin
from app.ingestion.parsers.mentions import parse_mentions
from app.ingestion.parsers.technical_seo import (
    parse_technical_seo_metrics,
    parse_technical_seo_register,
)
from app.ingestion.parsers.social import (
    parse_meta_social,
    parse_tiktok,
    parse_influencers,
)


PARSER_MAP = {
    "ahrefs_backlinks":        ("Ahrefs backlinks",            parse_ahrefs),
    "ahrefs_trends":           ("Ahrefs trends",               parse_ahrefs_trends),
    "competitor_benchmark":    ("Competitor benchmark",        parse_competitor_benchmark),
    # similarweb_traffic stays parseable so months built from old uploads
    # still render, but it's no longer an upload card (GA4 geography
    # replaced it - real measured data instead of estimates).
    "similarweb_traffic":      ("Similarweb traffic",          parse_similarweb),
    "ga4_export":              ("GA4 export",                  parse_ga4),
    "ga4_geography":           ("GA4 geography",               parse_ga4_geography),
    "search_console":          ("Search Console",              parse_search_console),
    "core_keywords":           ("Core keywords",               parse_core_keywords),
    "linkedin_company":        ("LinkedIn (company)",          parse_linkedin),
    "meta_social":             ("Facebook & Instagram",        parse_meta_social),
    "tiktok":                  ("TikTok",                      parse_tiktok),
    "influencer_activity":     ("Influencer activity",         parse_influencers),
    "mentions":                ("Media mentions",              parse_mentions),
    "technical_seo_metrics":   ("Technical SEO metrics",       parse_technical_seo_metrics),
    "technical_seo_register":  ("Technical SEO issue register",parse_technical_seo_register),
}


# Source definitions — drives the upload UI cards
SOURCE_DEFS = [
    {"key": "mentions",               "title": "Media mentions",        "purpose": "Coverage, sentiment, exec mentions",          "cols": "title, url, source, date"},
    {"key": "ga4_export",             "title": "GA4",                   "purpose": "Sessions, users, top pages",                  "cols": "sessions, users, pagePath"},
    {"key": "ga4_geography",          "title": "GA4 geography",         "purpose": "Visits by country",                           "cols": "Country, Sessions"},
    {"key": "search_console",         "title": "Search Console",        "purpose": "Clicks, impressions, CTR, position",          "cols": "query, clicks, impressions, ctr"},
    {"key": "core_keywords",          "title": "Core keywords",         "purpose": "Organic positions vs last month",             "cols": "keyword, location, volume, position, position_prev"},
    {"key": "ahrefs_backlinks",       "title": "Ahrefs backlinks",      "purpose": "Referring domains, backlink growth",          "cols": "referring_domain, domain_rating"},
    {"key": "ahrefs_trends",          "title": "Ahrefs trends",         "purpose": "12-month DR, referring domains, organic traffic", "cols": "month, domain_rating, referring_domains, organic_traffic"},
    {"key": "competitor_benchmark",   "title": "Competitor benchmark",  "purpose": "Share of voice vs competitors",               "cols": "month, brand, domain, organic_traffic"},
    {"key": "linkedin_company",       "title": "LinkedIn (company)",    "purpose": "Impressions, followers, visitors, top posts", "cols": "the three LinkedIn exports: content, followers, visitors (.xls)"},
    {"key": "meta_social",            "title": "Facebook & Instagram",  "purpose": "Views, reach, interactions, link clicks",     "cols": "platform, views, reach, interactions, link clicks (+ date for spikes)"},
    {"key": "tiktok",                 "title": "TikTok",                "purpose": "Views, likes, comments, shares",              "cols": "views, likes, comments, shares (+ date for spikes)"},
    {"key": "influencer_activity",    "title": "Influencer activity",   "purpose": "Creator posts, reach, engagement",            "cols": "influencer, platform, content, reach, engagements, link"},
    {"key": "technical_seo_metrics",  "title": "Health metrics",        "purpose": "Site health score, DR, open issues by month", "cols": "month, health_score, domain_rating, total_open"},
    {"key": "technical_seo_register", "title": "Issue register",        "purpose": "Issue register with severity and status",     "cols": "issue_id, finding, severity, status"},
]


# Visual grouping for the workspace data cards — related sources sit together
# in one accordion. Order inside "sources" is the display order.
SOURCE_GROUPS = [
    {"key": "media",     "label": "Media & PR",              "sources": ["mentions"]},
    {"key": "traffic",   "label": "Search & site traffic",   "sources": ["ga4_export", "search_console", "core_keywords", "ga4_geography"]},
    {"key": "authority", "label": "Authority & competitors", "sources": ["ahrefs_backlinks", "ahrefs_trends", "competitor_benchmark"]},
    {"key": "social",    "label": "Social & influencers",    "sources": ["linkedin_company", "meta_social", "tiktok", "influencer_activity"]},
    {"key": "technical", "label": "Technical SEO",           "sources": ["technical_seo_metrics", "technical_seo_register"]},
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

    if source_key == "core_keywords":
        d = data or {}
        tracked = d.get("tracked") or 0
        if not tracked:
            return {"status": "warning", "summary": "No keywords found - needs a keyword column",
                    "warnings": [], "row_count": 0}
        s = f"{tracked} keywords, {d.get('top3', 0)} in the top 3, {d.get('top10', 0)} in the top 10"
        if d.get("gains"):
            s += f", {len(d['gains'])} new top 5"
        if d.get("losses"):
            s += f", {len(d['losses'])} falling"
        unranked = tracked - (d.get("ranked") or 0)
        if unranked:
            warnings.append(f"{unranked} keyword{'s' if unranked != 1 else ''} with no position - the site does not rank in the top 100 for {'them' if unranked != 1 else 'it'}")
        return {"status": "ok", "summary": s, "warnings": warnings, "row_count": tracked}

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

    if source_key == "competitor_benchmark":
        rows = (data or {}).get("rows") or []
        if not rows:
            return {"status": "warning", "summary": "No benchmark rows found", "warnings": [], "row_count": 0}
        client_row = next((r for r in rows if r.get("is_client")), None)
        s = f"{len(rows)} brands"
        if client_row:
            s += f", you: {client_row['share']}% SoV"
            if client_row.get("share_delta") is not None:
                s += f" ({client_row['share_delta']:+g} MoM)"
        return {"status": "ok", "summary": s, "warnings": [], "row_count": len(rows)}

    if source_key == "ahrefs_trends":
        points = (data or {}).get("points") or []
        latest = (data or {}).get("latest") or {}
        deltas = (data or {}).get("deltas") or {}
        if not points:
            return {"status": "warning", "summary": "No history rows found", "warnings": [], "row_count": 0}
        s = f"{len(points)} months"
        if latest.get("domain_rating") is not None:
            s += f", DR {latest['domain_rating']}"
            if deltas.get("domain_rating"):
                s += f" ({deltas['domain_rating']:+g})"
        if latest.get("referring_domains") is not None:
            s += f", {latest['referring_domains']:,} ref domains"
            if deltas.get("referring_domains"):
                s += f" ({deltas['referring_domains']:+,})"
        return {"status": "ok", "summary": s, "warnings": [], "row_count": len(points)}

    if source_key == "ga4_geography":
        countries = (data or {}).get("top_countries") or []
        visits = (data or {}).get("total_visits") or 0
        if not countries:
            return {"status": "warning", "summary": "No countries found - needs Country + Sessions columns",
                    "warnings": [], "row_count": 0}
        top = countries[0]
        s = f"{len(countries)} countries, top: {top['country']} ({top['share']}%)"
        if visits:
            s += f", {visits:,} sessions"
        return {"status": "ok", "summary": s, "warnings": [], "row_count": len(countries)}

    if source_key == "similarweb_traffic":
        visits = (data or {}).get("total_visits") or 0
        countries = len((data or {}).get("top_countries", []))
        s = f"{visits:,} total visits"
        if countries:
            s += f", {countries} countries"
        return {"status": "ok" if visits > 0 else "warning", "summary": s,
                "warnings": [], "row_count": visits}

    if source_key == "linkedin_company":
        d = data or {}
        kinds = d.get("kinds") or []
        bits = []
        if d.get("followers"):
            bits.append(f"{d['followers']:,} followers")
        if d.get("follower_growth"):
            bits.append(f"+{d['follower_growth']:,} new")
        if d.get("impressions"):
            bits.append(f"{d['impressions']:,} impressions")
        if d.get("page_views"):
            bits.append(f"{d['page_views']:,} page views")
        warnings = []
        missing = [k for k in ("content", "followers", "visitors") if k not in kinds]
        if kinds and missing:
            warnings.append(
                f"Have {', '.join(kinds)} - still missing the {', '.join(missing)} "
                f"export{'s' if len(missing) != 1 else ''}. Drop each LinkedIn file on this card."
            )
        return {"status": "ok" if bits else "warning",
                "summary": ", ".join(bits) or "No LinkedIn metrics found - is this a LinkedIn analytics export?",
                "warnings": warnings,
                "row_count": d.get("followers") or d.get("impressions") or 0}

    if source_key == "meta_social":
        platforms = (data or {}).get("platforms") or []
        if not platforms:
            return {"status": "warning", "summary": "No platform rows found - needs a views/reach column, ideally with a platform column",
                    "warnings": [], "row_count": 0}
        bits = []
        for p in platforms:
            v = p.get("views")
            bits.append(f"{p['platform']}: {v:,.0f} views".replace(".0", "") if v else p["platform"])
        return {"status": "ok", "summary": ", ".join(bits), "warnings": [], "row_count": len(platforms)}

    if source_key == "tiktok":
        views = (data or {}).get("views") or 0
        likes = (data or {}).get("likes") or 0
        s = f"{views:,} views, {likes:,} likes"
        return {"status": "ok" if views > 0 else "warning", "summary": s,
                "warnings": [] if views > 0 else ["No views found - check there is a Views or Video views column"],
                "row_count": views}

    if source_key == "influencer_activity":
        rows = (data or {}).get("rows") or []
        s = f"{len(rows)} influencer post{'s' if len(rows) != 1 else ''}"
        reach = (data or {}).get("total_reach")
        if reach:
            s += f", {reach:,} combined reach"
        return {"status": "ok" if rows else "warning", "summary": s,
                "warnings": [] if rows else ["No rows found - needs an Influencer/Creator column"],
                "row_count": len(rows)}

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
