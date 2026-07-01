"""Report builder — orchestrates parsing, sentiment, synthesis, and rendering."""
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.clients import get_client
from app.config import settings
from app.db import upsert_report
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


def build_report(client_slug: str, period: str) -> dict:
    """Build the report for one client+period. Returns dict with paths and report id."""
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

    # 4. Render HTML
    context = {
        "client": client_config,
        "period": period,
        "period_display": _period_display(period),
        "generated_at": datetime.utcnow().strftime("%d %b %Y"),
        "app_url": settings.app_url,
        "data": parsed,
        "sentiment": sentiment,
        "actions": actions,
    }

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


def _period_display(period: str) -> str:
    """2026-06 -> 'June 2026'."""
    try:
        dt = datetime.strptime(period, "%Y-%m")
        return dt.strftime("%B %Y")
    except ValueError:
        return period
