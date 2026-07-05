"""Report builder — orchestrates parsing, sentiment, synthesis, and rendering."""
import base64
import json
from datetime import datetime, timedelta
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.clients import get_client
from app.config import settings
from app.db import upsert_report, get_commentary, upsert_commentary
from app.ingestion.parsers import parse_all
from app.reports.pdf import render_pdf
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

    # 2. Sentiment classification on mentions (cached per mention)
    mentions_data = parsed.get("mentions", {}).get("data") or {}
    mention_list = mentions_data.get("mentions", [])
    _progress("sentiment", f"0/{len(mention_list)}" if mention_list else "no mentions")
    sentiment = classify_mentions(
        mention_list,
        client_config,
        progress=lambda i, n: _progress("sentiment", f"{i}/{n}"),
    )

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

    synthesis_health = {"ran": False, "ok": None, "error": None}
    if saved_actions:
        actions = {"configured": True, "content": saved_actions}
    else:
        _progress("synthesis")
        assembled = {**parsed, "sentiment": sentiment}
        actions = synthesise_actions(assembled, client_config)
        synthesis_health = {
            "ran": True,
            "ok": bool(actions.get("configured") and actions.get("content")),
            "error": actions.get("error"),
        }

    # 3b. Commentary — seed from AI actions on first build, then use saved edits.
    commentary = _load_or_seed_commentary(client_slug, period, actions)
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

    return {
        "client": client_config,
        "exec_mentions": _detect_exec_mentions(parsed, client_config),
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


def _load_or_seed_commentary(client_slug: str, period: str, actions: dict) -> dict:
    """Return commentary as a dict {headline, standfirst, notes, actions}.

    On the first build for a period, seed a row from the AI-generated actions so the
    review screen has something to edit. On later builds, use the saved edits verbatim.
    """
    row = get_commentary(client_slug, period)
    if row is None:
        content = (actions or {}).get("content") or {}
        # The synthesis response carries editorial framing (headline,
        # standfirst, per-section notes) alongside the action buckets -
        # split them into their commentary homes so the review screen
        # opens pre-written rather than blank.
        seed_actions = {
            k: content[k]
            for k in ("lean_into", "investigate", "fix_urgently", "worked", "watch")
            if content.get(k)
        } or None
        upsert_commentary(
            client_slug, period,
            headline=(content.get("headline") or "Performance Report").strip(),
            standfirst=(content.get("standfirst") or "").strip(),
            notes_json=json.dumps(content.get("notes") or {}),
            actions_json=json.dumps(seed_actions) if seed_actions else None,
        )
        row = get_commentary(client_slug, period)

    return {
        "headline": row.get("headline") or "Performance Report",
        "standfirst": row.get("standfirst") or "",
        "notes": json.loads(row["notes_json"]) if row.get("notes_json") else {},
        "actions": json.loads(row["actions_json"]) if row.get("actions_json") else None,
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

    return {
        "current": current,
        "is_baseline": is_baseline,
        "health_delta": health_delta,
        "dr_delta": dr_delta,
        "open_issues": open_issues,
        "high_med_issues": high_med,
        "low_issues": low,
        "low_count": len(low),
    }


def _period_display(period: str) -> str:
    """2026-06 -> 'June 2026'."""
    try:
        dt = datetime.strptime(period, "%Y-%m")
        return dt.strftime("%B %Y")
    except ValueError:
        return period
