"""Report builder — orchestrates parsing, sentiment, synthesis, and rendering."""
import json
from datetime import datetime
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
    return env


def build_context(client_slug: str, period: str) -> dict:
    """Assemble the full render context for a report (parse, sentiment, synthesis, commentary).

    Shared by build_report (writes HTML + PDF) and the review screen (renders editable).
    """
    client_config = get_client(client_slug)

    data_dir = settings.data_dir / client_slug / period
    if not data_dir.exists():
        raise FileNotFoundError(f"No data folder for {client_slug}/{period}")

    # 1. Parse everything in the data folder
    parsed = parse_all(data_dir)

    # 2. Sentiment classification on mentions
    mentions_data = parsed.get("mentions", {}).get("data") or {}
    sentiment = classify_mentions(
        mentions_data.get("mentions", []),
        client_config,
    )

    # 3. Next month's actions via synthesis
    assembled = {**parsed, "sentiment": sentiment}
    actions = synthesise_actions(assembled, client_config)

    # 3b. Commentary — seed from AI actions on first build, then use saved edits.
    commentary = _load_or_seed_commentary(client_slug, period, actions)

    # If the operator has edited the recommendations, override the AI output.
    if commentary.get("actions"):
        actions = {"configured": True, "content": commentary["actions"]}

    # Client logo for the cover chip, if one exists in static/img/clients/
    logo_path = Path(__file__).parent.parent / "static" / "img" / "clients" / f"{client_slug}.png"
    client_logo = f"/static/img/clients/{client_slug}.png" if logo_path.exists() else None

    return {
        "client": client_config,
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
        "technical_seo": _build_technical_seo(parsed, period),
        "editable": False,
    }


def build_report(client_slug: str, period: str) -> dict:
    """Build the report for one client+period. Returns dict with paths and report id."""
    context = build_context(client_slug, period)

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
    report_id = upsert_report(client_slug, period, str(html_path), str(pdf_path))

    return {
        "report_id": report_id,
        "html_path": str(html_path),
        "pdf_path": str(pdf_path),
        "period": period,
        "client_slug": client_slug,
    }


def _load_or_seed_commentary(client_slug: str, period: str, actions: dict) -> dict:
    """Return commentary as a dict {headline, standfirst, notes, actions}.

    On the first build for a period, seed a row from the AI-generated actions so the
    review screen has something to edit. On later builds, use the saved edits verbatim.
    """
    row = get_commentary(client_slug, period)
    if row is None:
        seed_actions = (actions or {}).get("content") or None
        upsert_commentary(
            client_slug, period,
            headline="Performance Report",
            standfirst="",
            notes_json=json.dumps({}),
            actions_json=json.dumps(seed_actions) if seed_actions else None,
        )
        row = get_commentary(client_slug, period)

    return {
        "headline": row.get("headline") or "Performance Report",
        "standfirst": row.get("standfirst") or "",
        "notes": json.loads(row["notes_json"]) if row.get("notes_json") else {},
        "actions": json.loads(row["actions_json"]) if row.get("actions_json") else None,
    }


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
