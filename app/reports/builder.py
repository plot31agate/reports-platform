"""Report builder — orchestrates parsing, sentiment, synthesis, and rendering."""
import base64
import hashlib
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.clients import get_client
from app.config import settings
from app.db import (
    upsert_report, get_commentary, upsert_commentary,
    get_mention_overrides, set_commentary_ai_state,
)
from app.ingestion.parsers import parse_all
from app.reports.pdf import render_pdf
from app.reports.sections import enabled_sections
from app.sentiment import classify_mentions, synthesise_actions


def _env() -> Environment:
    templates_dir = Path(__file__).parent.parent / "templates"
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["thousands"] = lambda v: f"{v:,}" if isinstance(v, (int, float)) else v
    env.filters["duration"] = _fmt_duration
    env.filters["rowkey"] = _rowkey
    # Same cache-buster the admin app uses, so restyled reports refresh too.
    try:
        css_dir = Path(__file__).parent.parent / "static" / "css"
        env.globals["static_v"] = str(int(max(p.stat().st_mtime for p in css_dir.glob("*.css"))))
    except (ValueError, OSError):
        env.globals["static_v"] = "1"
    return env


def build_context(client_slug: str, period: str, progress=None) -> dict:
    """Assemble the full render context for a report (parse, sentiment, synthesis, commentary).

    Shared by build_report (writes HTML + PDF) and the review screen (renders editable).
    `progress(stage, detail)` is called as stages advance, when provided.
    """
    def _progress(stage, detail=""):
        if progress:
            progress(stage, detail)

    client_config = get_client(client_slug)

    data_dir = settings.data_dir / client_slug / period
    if not data_dir.exists():
        raise FileNotFoundError(f"No data folder for {client_slug}/{period}")

    # 1. Parse everything in the data folder
    _progress("parsing")
    parsed = parse_all(data_dir)

    # Pre-render trend sparklines as SVG images: inline <svg> is invisible to
    # WeasyPrint, but SVG data-URI <img> renders in browsers and PDF alike.
    trends = (parsed.get("ahrefs_trends") or {}).get("data")
    if trends and trends.get("points"):
        pts = trends["points"][-12:]
        trends["svgs"] = {
            key: _trend_svg(pts, key, (trends.get("max") or {}).get(key) or 1)
            for key in ("domain_rating", "referring_domains", "organic_traffic")
        }

    # 2. Sentiment classification on mentions (cached per mention).
    #    Operator overrides from the review screen are applied first: excluded
    #    stories drop out of the report and the sentiment maths entirely, and a
    #    per-story sentiment override replaces the AI's call.
    #    Skipped entirely for SEO-only reports (no media section): those never
    #    render coverage, so there's no point scoring mentions or paying for it,
    #    even if a stray mentions file is sitting in the data folder.
    media_on = "media" in enabled_sections(client_config)
    if media_on:
        mentions_data = parsed.get("mentions", {}).get("data") or {}
        all_mentions = mentions_data.get("mentions", [])
        overrides = get_mention_overrides(client_slug, period)
        for m in all_mentions:
            key = _mention_key(m)
            ov = overrides.get(key) or {}
            m["_key"] = key
            m["_excluded"] = bool(ov.get("excluded"))
            m["_sentiment_override"] = ov.get("sentiment") or None

        active_mentions = [m for m in all_mentions if not m["_excluded"]]
        # The report and every count run off the active set; the full annotated
        # list stays on the data dict so the review screen can show excluded rows
        # (to un-exclude) and each story's current override.
        mentions_data["total"] = len(active_mentions)
        mentions_data["all_mentions"] = all_mentions
        mentions_data["mentions"] = active_mentions

        _progress("sentiment", f"0/{len(active_mentions)}" if active_mentions else "no mentions")
        sentiment = classify_mentions(
            active_mentions,
            client_config,
            progress=lambda i, n: _progress("sentiment", f"{i}/{n}"),
        )
        _apply_sentiment_overrides(sentiment, active_mentions)
    else:
        sentiment = classify_mentions([], client_config)

    # 3. Next month's actions. Once the operator has saved edits, those win —
    #    skip the synthesis call entirely so review loads and republishes are
    #    fast and don't burn API calls regenerating text that gets overridden.
    saved = get_commentary(client_slug, period)
    saved_actions = None
    if saved and saved.get("actions_json"):
        try:
            saved_actions = json.loads(saved["actions_json"])
        except (ValueError, TypeError):
            saved_actions = None

    # Synthesis also runs when the saved commentary is still untouched
    # defaults (months built before AI framing existed), and when the month's
    # data has changed since the last synthesis (e.g. a scan pulled new
    # mentions) — otherwise the commentary keeps describing numbers that are
    # no longer in the report. The merge below still protects operator edits.
    fingerprint = _synthesis_fingerprint(parsed, sentiment, client_config)
    data_changed = bool(saved) and (saved.get("data_fingerprint") or "") != fingerprint

    synthesis_health = {"ran": False, "ok": None, "error": None}
    synth_content = None
    if (saved_actions and not _framing_blank(saved) and _has_intro(saved)
            and not data_changed and not _blanked_ai_fields(saved)):
        actions = {"configured": True, "content": saved_actions}
    else:
        _progress("synthesis")
        assembled = {**parsed, "sentiment": sentiment}
        result = synthesise_actions(assembled, client_config)
        synth_content = result.get("content")
        synthesis_health = {
            "ran": True,
            "ok": bool(result.get("configured") and result.get("content")),
            "error": result.get("error"),
        }
        if saved_actions:
            actions = {"configured": True, "content": saved_actions}
        else:
            actions = result

    # 3b. Commentary — seed from AI framing on first build, refresh AI-written
    #     fields when the data changed, and always let saved operator edits win.
    commentary = _load_or_seed_commentary(client_slug, period, synth_content, fingerprint)
    if commentary.get("actions"):
        actions = {"configured": True, "content": commentary["actions"]}

    # AI health — surfaced in the admin UI so a degraded build is loud, not
    # silently rendered as "neutral" sentiment and a blank actions section.
    ai_health = {
        "configured": bool(settings.anthropic_api_key),
        "sentiment_total": sentiment.get("total", 0),
        "sentiment_failed": sentiment.get("failed", 0),
        "sentiment_cached": sentiment.get("from_cache", 0),
        "synthesis": synthesis_health,
        "warnings": [],
    }
    if not ai_health["configured"]:
        ai_health["warnings"].append(
            "ANTHROPIC_API_KEY is not set - sentiment and recommendations were skipped."
        )
    if ai_health["sentiment_failed"]:
        ai_health["warnings"].append(
            f"{ai_health['sentiment_failed']} of {ai_health['sentiment_total']} mentions could not be classified - they are excluded from the sentiment score."
        )
    if synthesis_health["ran"] and not synthesis_health["ok"]:
        ai_health["warnings"].append(
            "Recommendation synthesis failed - the next-month actions section is empty."
            + (f" ({synthesis_health['error'][:120]})" if synthesis_health.get("error") else "")
        )

    # Client logo for the cover chip, if one exists in static/img/clients/
    logo_path = Path(__file__).parent.parent / "static" / "img" / "clients" / f"{client_slug}.png"
    client_logo = f"/static/img/clients/{client_slug}.png" if logo_path.exists() else None

    technical_seo = _build_technical_seo(parsed, period)
    exec_mentions = _detect_exec_mentions(parsed, client_config)

    return {
        "client": client_config,
        "enabled_sections": set(enabled_sections(client_config)),
        "exec_mentions": exec_mentions,
        "stat_groups": _build_stat_groups(parsed, sentiment, exec_mentions, technical_seo, commentary),
        # Rows the operator has dropped on the review screen. Published mode
        # skips them; review mode renders them unticked so they can come back.
        "hidden": set((commentary.get("notes") or {}).get("hidden") or []),
        # Whole sections switched off for this month only. The client's
        # standing section list in settings is left alone.
        "hidden_sections": set((commentary.get("notes") or {}).get("hidden_sections") or []),
        # Rewritten cell text, keyed the same way as rows. Only cells the
        # operator actually changed are stored, so everything else keeps
        # tracking the data on the next sync.
        "cells": (commentary.get("notes") or {}).get("cells") or {},
        "mom": _build_mom(client_slug, period, parsed, technical_seo),
        "client_slug": client_slug,
        "client_logo": client_logo,
        "period": period,
        "period_display": _period_display(period),
        "generated_at": datetime.utcnow().strftime("%d %b %Y"),
        "app_url": settings.app_url,
        "data": parsed,
        "sentiment": sentiment,
        "actions": actions,
        "commentary": commentary,
        "technical_seo": technical_seo,
        "ai_health": ai_health,
        "editable": False,
    }


def build_report(client_slug: str, period: str, progress=None) -> dict:
    """Build the report for one client+period. Returns dict with paths and report id."""
    def _progress(stage, detail=""):
        if progress:
            progress(stage, detail)

    context = build_context(client_slug, period, progress=progress)

    _progress("rendering")
    env = _env()
    html = env.get_template("report.html").render(**context)

    # 5. Write HTML file
    out_dir = settings.reports_out_dir / client_slug
    out_dir.mkdir(parents=True, exist_ok=True)
    html_path = out_dir / f"{period}.html"
    html_path.write_text(html, encoding="utf-8")

    # 6. Render PDF from the same HTML
    pdf_path = out_dir / f"{period}.pdf"
    render_pdf(html, pdf_path)

    # 7. Save to DB
    _progress("saving")
    report_id = upsert_report(client_slug, period, str(html_path), str(pdf_path))

    return {
        "report_id": report_id,
        "html_path": str(html_path),
        "pdf_path": str(pdf_path),
        "period": period,
        "client_slug": client_slug,
        "ai_health": context.get("ai_health"),
    }


ACTION_BUCKETS = ("lean_into", "investigate", "fix_urgently", "worked", "watch")


def _framing_blank(row: dict | None) -> bool:
    """True when a commentary row carries no editorial framing yet -
    default headline, no standfirst, no section notes."""
    if row is None:
        return True
    if (row.get("headline") or "Performance Report").strip() not in ("", "Performance Report"):
        return False
    if (row.get("standfirst") or "").strip():
        return False
    notes = _dict(_loads(row.get("notes_json")))
    return not any(v.strip() for v in notes.values() if isinstance(v, str))


def _blanked_ai_fields(row: dict | None) -> bool:
    """True when the operator has blanked a field the AI previously wrote -
    treated as 'regenerate this' on the next build, so clearing a stale note
    in review and saving gets it rewritten from the current data."""
    if row is None:
        return False
    seed = _dict(_loads(row.get("ai_seed_json")))
    if not seed:
        return False
    if _str(seed.get("headline")) and _str(row.get("headline")) in ("", "Performance Report"):
        return True
    if _str(seed.get("standfirst")) and not _str(row.get("standfirst")):
        return True
    seed_notes = _dict(seed.get("notes"))
    notes = _dict(_loads(row.get("notes_json")))
    if any(_str(seed_notes.get(k)) and not _str(notes.get(k)) for k in seed_notes):
        return True
    # Same rule for the action buckets. Saving the review screen always writes
    # every bucket, so leaving "what worked" blank stores an empty list - which
    # would otherwise read as a deliberate edit and suppress the section for
    # good, even on months where the AI had written one.
    seed_actions = _dict(seed.get("actions"))
    actions = _dict(_loads(row.get("actions_json")))
    return any(seed_actions.get(k) and not actions.get(k) for k in seed_actions)


def _has_intro(row: dict | None) -> bool:
    """True when the commentary already carries an executive-summary intro."""
    if row is None:
        return False
    intro = _dict(_loads(row.get("notes_json"))).get("intro")
    return bool(intro.strip()) if isinstance(intro, str) else False


def _loads(raw):
    try:
        return json.loads(raw) if raw else None
    except (ValueError, TypeError):
        return None


def _dict(v):
    """Coerce to a dict - Claude output and stored JSON are trusted loosely."""
    return v if isinstance(v, dict) else {}


def _str(v):
    return v.strip() if isinstance(v, str) else ""


def _synthesis_fingerprint(parsed: dict, sentiment: dict, client_config: dict) -> str:
    """Stable hash of everything the synthesis prompt reads, so a rebuild can
    tell whether its output would actually differ. Volatile bookkeeping
    (cache hits, failure counts, per-call rationale text) is left out.

    The editorial config belongs here alongside the data: the focus brief and
    the enabled-section list steer the prompt just as much as the numbers do.
    Hashing the data alone means an operator who retunes the focus in settings
    (say, to stop a report leading on media coverage) keeps being served the
    commentary written under the old brief, because nothing looks changed.
    """
    from app.reports.sections import enabled_sections

    payload = {
        "sources": {k: (v or {}).get("data") for k, v in parsed.items()},
        "sentiment": {
            "total": sentiment.get("total"),
            "positive": sentiment.get("positive"),
            "neutral": sentiment.get("neutral"),
            "negative": sentiment.get("negative"),
            "avg_score": sentiment.get("avg_score"),
            "keys": sorted(s.get("_key") or "" for s in sentiment.get("scored") or []),
        },
        "editorial": {
            "report_focus": (client_config.get("report_focus") or "").strip(),
            "sentiment_context": (client_config.get("sentiment_context") or "").strip(),
            "sections": sorted(enabled_sections(client_config)),
        },
    }
    return hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _ai_seed(content: dict) -> dict:
    """The AI-authored values worth remembering, normalised the same way they
    are written into the commentary row - so equality against the row later
    means 'the operator never touched this'."""
    return {
        "headline": _str(content.get("headline")),
        "standfirst": _str(content.get("standfirst")),
        "notes": {k: v.strip() for k, v in _dict(content.get("notes")).items() if isinstance(v, str) and v.strip()},
        "actions": {k: content[k] for k in ACTION_BUCKETS if content.get(k)} or None,
    }


def _load_or_seed_commentary(client_slug: str, period: str, synth_content: dict | None, fingerprint: str | None = None) -> dict:
    """Return commentary as a dict {headline, standfirst, notes, actions}.

    On the first build for a period, seed the row from the synthesis output
    (headline, standfirst, notes, action buckets) so the review screen opens
    pre-written. On later builds, fresh synthesis fills blank fields and
    refreshes fields still carrying the AI's previous text (tracked in
    ai_seed_json) - anything the operator has edited is never touched.
    """
    content = _dict(synth_content)
    seed_notes = {k: v.strip() for k, v in _dict(content.get("notes")).items() if isinstance(v, str) and v.strip()}
    seed_actions = {k: content[k] for k in ACTION_BUCKETS if content.get(k)} or None

    row = get_commentary(client_slug, period)
    if row is None:
        upsert_commentary(
            client_slug, period,
            headline=_str(content.get("headline")) or "Performance Report",
            standfirst=_str(content.get("standfirst")),
            notes_json=json.dumps(seed_notes),
            actions_json=json.dumps(seed_actions) if seed_actions else None,
        )
        if content:
            set_commentary_ai_state(client_slug, period, json.dumps(_ai_seed(content)), fingerprint)
        row = get_commentary(client_slug, period)
    elif content:
        prev_seed = _dict(_loads(row.get("ai_seed_json")))
        prev_notes = _dict(prev_seed.get("notes"))

        headline = _str(row.get("headline"))
        standfirst = _str(row.get("standfirst"))
        notes = _dict(_loads(row.get("notes_json")))
        actions = _loads(row.get("actions_json"))

        changed = False
        if _str(content.get("headline")) and headline in ("", "Performance Report", _str(prev_seed.get("headline"))):
            if headline != _str(content["headline"]):
                headline = _str(content["headline"])
                changed = True
        if _str(content.get("standfirst")) and standfirst in ("", _str(prev_seed.get("standfirst"))):
            if standfirst != _str(content["standfirst"]):
                standfirst = _str(content["standfirst"])
                changed = True
        for key, val in seed_notes.items():
            current = _str(notes.get(key))
            if current in ("", _str(prev_notes.get(key))) and current != val:
                notes[key] = val
                changed = True
        # Merge action buckets one at a time, the same way notes are handled.
        # All-or-nothing meant a single edited bucket froze every other one,
        # so a blank "what worked" could never be refilled by a later build.
        if seed_actions:
            prev_actions = _dict(prev_seed.get("actions"))
            merged = _dict(actions)
            for bucket in ACTION_BUCKETS:
                val = seed_actions.get(bucket)
                current = merged.get(bucket)
                if val and (not current or current == prev_actions.get(bucket)):
                    if current != val:
                        merged[bucket] = val
                        changed = True
            actions = merged or None

        if changed:
            upsert_commentary(
                client_slug, period,
                headline=headline or "Performance Report",
                standfirst=standfirst,
                notes_json=json.dumps(notes),
                actions_json=json.dumps(actions) if actions else None,
            )
        # Always record what the AI wrote and the data it read, even when no
        # field was applied - otherwise a fully-edited report would re-run
        # synthesis on every build.
        set_commentary_ai_state(client_slug, period, json.dumps(_ai_seed(content)), fingerprint)
        if changed:
            row = get_commentary(client_slug, period)

    return {
        "headline": row.get("headline") or "Performance Report",
        "standfirst": row.get("standfirst") or "",
        "notes": _dict(_loads(row.get("notes_json"))),
        "actions": _loads(row.get("actions_json")),
    }


def _trend_svg(points: list, key: str, maxv) -> str:
    """12-bar sparkline as a base64 SVG data URI. Current month highlighted."""
    n = len(points)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n * 10} 46" preserveAspectRatio="none">']
    for i, p in enumerate(points):
        v = p.get(key) or 0
        h = max(1.5, (v / maxv) * 42) if maxv else 1.5
        fill = "#fb0ba8" if i == n - 1 else "#01d0da"
        opacity = "" if i == n - 1 else ' opacity="0.5"'
        parts.append(
            f'<rect x="{i * 10}" y="{round(46 - h, 1)}" width="8" height="{round(h, 1)}" rx="1" fill="{fill}"{opacity}/>'
        )
    parts.append("</svg>")
    return "data:image/svg+xml;base64," + base64.b64encode("".join(parts).encode()).decode()


def _build_mom(client_slug: str, period: str, parsed: dict, technical_seo: dict | None) -> dict | None:
    """Month-on-month strip: this month's headline numbers against the prior
    month's data folder. First tracked month renders as a baseline."""
    try:
        dt = datetime.strptime(period, "%Y-%m")
    except ValueError:
        return None
    prev_dt = dt.replace(day=1) - timedelta(days=1)
    prev_period = prev_dt.strftime("%Y-%m")

    prev_dir = settings.data_dir / client_slug / prev_period
    has_prev = prev_dir.exists()
    prev_parsed = {}
    if has_prev:
        try:
            prev_parsed = parse_all(prev_dir)
        except Exception:
            prev_parsed = {}

    def dig(tree, src, key):
        node = ((tree.get(src) or {}).get("data") or {}) if tree else {}
        val = node.get(key) if isinstance(node, dict) else None
        return val if isinstance(val, (int, float)) else None

    specs = [
        ("Media mentions", "mentions", "total"),
        ("Organic clicks", "search_console", "clicks"),
        ("Sessions", "ga4_export", "sessions"),
        ("LinkedIn impressions", "linkedin_company", "impressions"),
        ("New followers", "linkedin_company", "follower_growth"),
        ("Facebook views", "meta_social", "fb_views"),
        ("Instagram views", "meta_social", "ig_views"),
        ("TikTok views", "tiktok", "views"),
        ("Referring domains", "ahrefs_backlinks", "referring_domains"),
    ]
    metrics = []
    for label, src, key in specs:
        cur = dig(parsed, src, key)
        if cur is None:
            continue
        prev_val = dig(prev_parsed, src, key)
        entry = {"label": label, "value": f"{cur:,}", "prev": None, "delta": None, "direction": None, "sub": None}
        if prev_val is not None:
            entry["prev"] = f"{prev_val:,}"
            if prev_val and cur != prev_val:
                pct = round((cur - prev_val) / abs(prev_val) * 100)
                entry["delta"] = f"{abs(pct)}%" if pct else f"{abs(cur - prev_val):,}"
                entry["direction"] = "up" if cur > prev_val else "down"
            else:
                entry["direction"] = "flat"
        metrics.append(entry)

    # Site health comes from the multi-month metrics file, delta pre-computed.
    if technical_seo and technical_seo.get("current"):
        cur_h = technical_seo["current"].get("health_score")
        if cur_h is not None:
            entry = {"label": "Site health", "value": f"{cur_h}/100", "prev": None, "delta": None, "direction": None, "sub": None}
            delta = technical_seo.get("health_delta")
            if delta is not None and not technical_seo.get("is_baseline"):
                entry["prev"] = f"{cur_h - delta}/100"
                if delta:
                    entry["delta"] = f"{abs(delta)} pts"
                    entry["direction"] = "up" if delta > 0 else "down"
                else:
                    entry["direction"] = "flat"
            metrics.append(entry)

    if not metrics:
        return None

    return {
        "metrics": metrics,
        "has_prev": any(m["prev"] is not None for m in metrics),
        "month_name": dt.strftime("%B"),
        "prev_name": prev_dt.strftime("%B"),
        "prev_period": prev_period,
    }


def _mention_key(m: dict) -> str:
    """Stable identity for a mention, matching the parser's dedup on
    normalised url + title - so an override survives a re-sync even if the
    snippet text shifts."""
    raw = (m.get("url", "").strip().lower().rstrip("/")) + "|" + (m.get("title", "").strip().lower())
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _apply_sentiment_overrides(sentiment: dict, mentions: list) -> None:
    """Apply per-story sentiment overrides in place, recompute the aggregate,
    and annotate each mention with _ai_sentiment (the model's call) and
    _effective_sentiment (what the report shows) for the templates."""
    override_by_key = {m["_key"]: m.get("_sentiment_override") for m in mentions}
    scored = sentiment.get("scored") or []
    for s in scored:
        s["_ai_classification"] = s.get("classification")
        ov = override_by_key.get(s.get("_key"))
        if ov:
            s["classification"] = ov
            s["_overridden"] = True

    counted = [s for s in scored if s.get("ok", True)]
    pos = sum(1 for s in counted if s["classification"] == "positive")
    neg = sum(1 for s in counted if s["classification"] == "negative")
    neu = sum(1 for s in counted if s["classification"] == "neutral")
    sentiment["positive"], sentiment["neutral"], sentiment["negative"] = pos, neu, neg
    sentiment["avg_score"] = round((pos - neg) / len(counted), 2) if counted else None

    scored_by_key = {s.get("_key"): s for s in scored}
    for m in mentions:
        s = scored_by_key.get(m["_key"]) or {}
        m["_ai_sentiment"] = s.get("_ai_classification")
        m["_effective_sentiment"] = m.get("_sentiment_override") or s.get("classification")


def _detect_exec_mentions(parsed: dict, client_config: dict) -> list:
    """Scan the month's mentions for the client's executive names.

    The Google Alerts feeds already include exec-name alerts, so the raw
    coverage is in the mentions corpus - this surfaces who appeared where.
    """
    mentions = ((parsed.get("mentions") or {}).get("data") or {}).get("mentions") or []
    out = []
    for name in client_config.get("executives") or []:
        needle = name.lower().strip()
        if not needle:
            continue
        hits = [
            m for m in mentions
            if needle in f"{m.get('title', '')} {m.get('snippet', '')}".lower()
        ]
        if hits:
            out.append({"name": name, "count": len(hits), "examples": hits[:2]})
    out.sort(key=lambda e: -e["count"])
    return out


def _build_stat_groups(parsed: dict, sentiment: dict, exec_mentions: list,
                       technical_seo: dict | None, commentary: dict) -> dict:
    """The number cards, assembled as data instead of hardcoded in the template
    so the review screen can edit them: relabel, rewrite the value, hide, or
    reorder. Overrides live in the commentary notes under 'stats', keyed
    '<group>.<stat>' — only deviations from the computed default are stored,
    so an untouched box keeps tracking the data on every rebuild."""
    def th(v):
        return f"{v:,}" if isinstance(v, (int, float)) else v

    groups: dict = {}

    def group(gkey, cls, stats):
        if stats:
            groups[gkey] = {"cls": cls, "stats": stats}

    def stat(gkey, key, value, label, unit="", extra=""):
        return {"id": f"{gkey}.{key}", "value": str(value), "label": label,
                "unit": unit, "extra": extra}

    mentions_total = ((parsed.get("mentions") or {}).get("data") or {}).get("total")
    if mentions_total:
        stats = [stat("media", "total", th(mentions_total), "Tracked mentions")]
        if sentiment.get("configured") and sentiment.get("total"):
            avg = sentiment.get("avg_score")
            stats.append(stat("media", "sentiment",
                              "{:+.2f}".format(avg) if avg is not None else "—",
                              "Net sentiment, −1 to +1"))
        if exec_mentions:
            stats.append(stat("media", "execs", len(exec_mentions), "Executives in coverage"))
        group("media", "stats", stats)

    gsc = (parsed.get("search_console") or {}).get("data")
    if gsc:
        group("gsc", "stats stats--4", [
            stat("gsc", "clicks", th(gsc.get("clicks") or 0), "Organic clicks"),
            stat("gsc", "impressions", th(gsc.get("impressions") or 0), "Impressions"),
            stat("gsc", "ctr", f"{round(gsc['avg_ctr'], 2)}%" if gsc.get("avg_ctr") else "—", "Average CTR"),
            stat("gsc", "position", round(gsc["avg_position"], 1) if gsc.get("avg_position") else "—", "Average position"),
        ])

    ga4 = (parsed.get("ga4_export") or {}).get("data")
    if ga4:
        wide = ga4.get("new_users") or ga4.get("avg_engagement_secs")
        stats = [stat("ga4", "users", th(ga4.get("users") or 0), "Users")]
        if ga4.get("new_users"):
            stats.append(stat("ga4", "new_users", th(ga4["new_users"]), "New users"))
        stats.append(stat("ga4", "sessions", th(ga4.get("sessions") or 0), "Sessions"))
        if ga4.get("avg_engagement_secs"):
            stats.append(stat("ga4", "engagement", _fmt_duration(ga4["avg_engagement_secs"]), "Avg engagement time"))
        elif ga4.get("engaged_sessions"):
            stats.append(stat("ga4", "engaged", th(ga4["engaged_sessions"]), "Engaged sessions"))
        group("ga4", "stats stats--4" if wide else "stats", stats)

    li = (parsed.get("linkedin_company") or {}).get("data")
    if li:
        stats = [stat("linkedin", "followers", th(li.get("followers") or 0), "Followers")]
        if li.get("follower_growth"):
            stats.append(stat("linkedin", "growth", "+" + th(li["follower_growth"]), "New followers"))
        if li.get("impressions"):
            stats.append(stat("linkedin", "impressions", th(li["impressions"]), "Post impressions"))
        if li.get("engagements"):
            stats.append(stat("linkedin", "engagements", th(li["engagements"]), "Engagements"))
        if li.get("page_views"):
            stats.append(stat("linkedin", "page_views", th(li["page_views"]), "Page views"))
        if li.get("unique_visitors"):
            stats.append(stat("linkedin", "visitors", th(li["unique_visitors"]), "Unique visitors"))
        group("linkedin", "stats stats--4", stats)

    tk = (parsed.get("tiktok") or {}).get("data")
    if tk and tk.get("views"):
        stats = [stat("tiktok", "views", th(tk["views"]), "Views")]
        if tk.get("likes") is not None:
            stats.append(stat("tiktok", "likes", th(tk["likes"]), "Likes"))
        if tk.get("comments") is not None:
            stats.append(stat("tiktok", "comments", th(tk["comments"]), "Comments"))
        if tk.get("shares") is not None:
            stats.append(stat("tiktok", "shares", th(tk["shares"]), "Shares"))
        group("tiktok", "stats stats--4", stats)

    if technical_seo:
        cur = technical_seo["current"]
        if not technical_seo["is_baseline"] and technical_seo["health_delta"]:
            d = technical_seo["health_delta"]
            arrow, direction = ("↑", "up") if d > 0 else ("↓", "down")
            health_extra = f'<div class="mt {direction}">{arrow} {d:+d} pts</div>'
        elif technical_seo["is_baseline"]:
            health_extra = '<div class="mt note">◆ Baseline month</div>'
        else:
            health_extra = ""
        open_extra = (f'<div class="mt down">{cur.get("high_open")} high severity</div>'
                      if cur.get("high_open") else "")
        group("technical_seo", "stats", [
            stat("technical_seo", "health", cur.get("health_score"), "Health score", unit="/100", extra=health_extra),
            stat("technical_seo", "dr", cur.get("domain_rating"), "Domain rating"),
            stat("technical_seo", "open", technical_seo["open_count"], "Open findings", extra=open_extra),
        ])

    overrides = ((commentary.get("notes") or {}).get("stats")) or {}
    for g in groups.values():
        for i, s in enumerate(g["stats"]):
            ov = overrides.get(s["id"]) or {}
            s["default_value"], s["default_label"], s["default_order"] = s["value"], s["label"], i
            s["value"] = ov.get("value") or s["value"]
            s["label"] = ov.get("label") or s["label"]
            s["hide"] = bool(ov.get("hide"))
            s["order"] = ov["order"] if isinstance(ov.get("order"), int) else i
        g["stats"].sort(key=lambda s: (s["order"], s["default_order"]))
    return groups


def _build_technical_seo(parsed: dict, period: str) -> dict | None:
    """Combine metrics + register into a single context dict with delta logic."""
    metrics_rows = (parsed.get("technical_seo_metrics") or {}).get("data") or []
    register_rows = (parsed.get("technical_seo_register") or {}).get("data") or []

    if not metrics_rows:
        return None

    current = next((r for r in metrics_rows if r["month"] == period), None)
    if not current:
        return None

    earliest = min(r["month"] for r in metrics_rows)
    is_baseline = (period == earliest)

    prior_candidates = [r for r in metrics_rows if r["month"] < period]
    prior = max(prior_candidates, key=lambda r: r["month"]) if prior_candidates else None

    health_delta = None
    dr_delta = None
    if prior and not is_baseline:
        health_delta = current["health_score"] - prior["health_score"]
        dr_delta = current["domain_rating"] - prior["domain_rating"]

    # Open issues = no resolved_month set
    open_issues = [i for i in register_rows if not i.get("resolved_month")]

    sev_order = {"High": 0, "Medium": 1, "Low": 2}
    stat_order = {"Confirmed": 0, "Verify": 1, "Action": 2}
    open_issues.sort(key=lambda i: (
        sev_order.get(i.get("severity", "Low"), 2),
        stat_order.get(i.get("status", "Action"), 2),
    ))

    high_med = [i for i in open_issues if i.get("severity") in ("High", "Medium")]
    low = [i for i in open_issues if i.get("severity") == "Low"]

    # The findings count comes from the register, but the severity badge and
    # the AI's prose read the metrics row. With no register uploaded that
    # renders as "0 open findings" under an "N high severity" badge, so fall
    # back to the metrics total and flag the gap on the review screen.
    register_missing = not register_rows
    open_count = current.get("total_open", 0) if register_missing else len(open_issues)

    return {
        "current": current,
        "is_baseline": is_baseline,
        "health_delta": health_delta,
        "dr_delta": dr_delta,
        "open_issues": open_issues,
        "open_count": open_count,
        "register_missing": register_missing,
        "high_med_issues": high_med,
        "low_issues": low,
        "low_count": len(low),
    }


def _rowkey(value) -> str:
    """Stable, form-safe id for one row or list item.

    Built from the row's own content (a domain, a query, an issue id) rather
    than its position, so hiding a row survives the data reshuffling on the
    next sync. Long values are truncated - collisions only ever affect rows
    that read identically anyway.
    """
    s = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return s[:60] or "item"


def _fmt_duration(secs) -> str:
    """Seconds -> '8m 10s' (or '42s' under a minute)."""
    if not isinstance(secs, (int, float)) or secs <= 0:
        return "—"
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    return f"{secs // 60}m {secs % 60:02d}s"


def _period_display(period: str) -> str:
    """2026-06 -> 'June 2026'."""
    try:
        dt = datetime.strptime(period, "%Y-%m")
        return dt.strftime("%B %Y")
    except ValueError:
        return period
