"""PDF rendering via WeasyPrint.

Renders the same HTML used for the web view, with print media stylesheet
adjustments applied in the template.
"""
from pathlib import Path


def render_pdf(html_content: str, out_path: Path) -> None:
    # Lazy import — WeasyPrint has native deps we don't want to load at app startup
    from weasyprint import HTML

    HTML(string=html_content, base_url=None).write_pdf(str(out_path))
