"""PDF rendering via WeasyPrint.

The web view links /static/css/brand.css and leans on CSS custom properties.
The VPS runs WeasyPrint 52.5, which has no var() support, and a string render
has no base URL to resolve /static/... against. So for PDF the HTML is
compiled into a self-contained document first: the stylesheet is inlined,
every var() reference is resolved to its literal value (client colour
overrides included), and static asset paths become file:// URLs.
"""
import re
from pathlib import Path

STATIC_DIR = Path(__file__).parent.parent / "static"
REPORT_CSS_PATH = STATIC_DIR / "css" / "report.css"

_VAR_DECL = re.compile(r"--([a-zA-Z0-9-]+)\s*:\s*([^;}]+)")
_VAR_REF = re.compile(r"var\(\s*--([a-zA-Z0-9-]+)\s*\)")
_CSS_LINK = re.compile(r'<link[^>]+href="/static/css/report\.css"[^>]*>')


def _collect_variables(*sources: str) -> dict:
    """Gather custom property declarations, later sources overriding earlier ones."""
    raw = {}
    for text in sources:
        for name, value in _VAR_DECL.findall(text):
            raw[name] = value.strip()

    def resolve(value: str, depth: int = 0) -> str:
        if depth > 10:
            return value
        return _VAR_REF.sub(lambda m: resolve(raw.get(m.group(1), "inherit"), depth + 1), value)

    return {name: resolve(value) for name, value in raw.items()}


def prepare_pdf_html(html: str) -> str:
    """Return a self-contained version of the report HTML for WeasyPrint."""
    report_css = REPORT_CSS_PATH.read_text(encoding="utf-8")
    # report.css defaults first, then the per-client :root overrides in the HTML head
    variables = _collect_variables(report_css, html)

    def substitute(text: str) -> str:
        return _VAR_REF.sub(lambda m: variables.get(m.group(1), "inherit"), text)

    report_css = substitute(report_css).replace("url('/static/", f"url('file://{STATIC_DIR}/")
    html = _CSS_LINK.sub(lambda m: "<style>\n" + report_css + "\n</style>", html, count=1)
    html = substitute(html)
    html = html.replace('src="/static/', f'src="file://{STATIC_DIR}/')
    return html


def render_pdf(html_content: str, out_path: Path) -> None:
    # Lazy import — WeasyPrint has native deps we don't want to load at app startup
    from weasyprint import HTML

    HTML(string=prepare_pdf_html(html_content), base_url=None).write_pdf(str(out_path))
