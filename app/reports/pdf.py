"""PDF rendering with automatic engine selection.

Engines, best first:

1. **chromium** — headless Chrome/Chromium `--print-to-pdf`. Pixel-identical
   to the web report: full flexbox, var(), modern text layout. Used when a
   binary is configured (CHROMIUM_BINARY in .env) or found on the system.
   On AlmaLinux 8: `dnf install epel-release && dnf install chromium-headless`.

2. **weasyprint >= 53** — no browser needed; handles var() and flex natively.
   (Note: needs Pango >= 1.44, which AlmaLinux 8 doesn't ship — hence the
   Chromium route for the VPS.)

3. **weasyprint 52.5 (legacy)** — the original pipeline: stylesheet inlined
   with every var() resolved to a literal, since 52.5 predates var support.
   Kept as the fallback so PDFs never stop working before any VPS setup.

All engines receive the same self-contained HTML (stylesheet inlined,
/static/ assets rewritten to file:// URLs); only var() handling differs.
"""
import glob
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from app.config import settings

STATIC_DIR = Path(__file__).parent.parent / "static"
REPORT_CSS_PATH = STATIC_DIR / "css" / "report.css"

_VAR_DECL = re.compile(r"--([a-zA-Z0-9-]+)\s*:\s*([^;}]+)")
_VAR_REF = re.compile(r"var\(\s*--([a-zA-Z0-9-]+)\s*\)")
# Tolerate a cache-busting query string (?v=...) on the stylesheet link.
_CSS_LINK = re.compile(r'<link[^>]+href="/static/css/report\.css[^"]*"[^>]*>')

CHROMIUM_NAMES = ["chromium-browser", "chromium", "google-chrome", "chrome"]
CHROMIUM_PATHS = [
    "/usr/lib64/chromium-browser/headless_shell",   # EPEL chromium-headless
    "/usr/lib64/chromium-browser/chromium-browser",
    "/usr/bin/chromium-browser",
]
CHROMIUM_GLOBS = [
    "/opt/pw-browsers/chromium-*/chrome-linux/chrome",  # Playwright installs (dev)
]


# ------------------- engine detection -------------------

def find_chromium():
    if settings.chromium_binary:
        p = Path(settings.chromium_binary)
        return str(p) if p.exists() else None
    for name in CHROMIUM_NAMES:
        found = shutil.which(name)
        if found:
            return found
    for path in CHROMIUM_PATHS:
        if Path(path).exists():
            return path
    for pattern in CHROMIUM_GLOBS:
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return None


def _weasyprint_version():
    try:
        import weasyprint
        return tuple(int(x) for x in weasyprint.__version__.split(".")[:2])
    except Exception:
        return None


def active_engine() -> str:
    """Which engine render_pdf will use — surfaced in admin diagnostics."""
    if settings.pdf_engine in ("auto", "chromium") and find_chromium():
        return "chromium"
    if settings.pdf_engine == "chromium":
        return "chromium (missing binary!)"
    ver = _weasyprint_version()
    if ver and ver >= (53, 0):
        return f"weasyprint {'.'.join(map(str, ver))}"
    return "weasyprint legacy (52.x)"


# ------------------- shared HTML preparation -------------------

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


def prepare_pdf_html(html: str, substitute_vars: bool = True) -> str:
    """Return a self-contained version of the report HTML.

    substitute_vars=True resolves every var() to a literal (needed only for
    WeasyPrint 52.5, which predates custom property support).
    """
    report_css = REPORT_CSS_PATH.read_text(encoding="utf-8")

    if substitute_vars:
        variables = _collect_variables(report_css, html)

        def substitute(text: str) -> str:
            return _VAR_REF.sub(lambda m: variables.get(m.group(1), "inherit"), text)

        report_css = substitute(report_css)
        html = substitute(html)

    report_css = report_css.replace("url('/static/", f"url('file://{STATIC_DIR}/")
    html = _CSS_LINK.sub(lambda m: "<style>\n" + report_css + "\n</style>", html, count=1)
    html = html.replace('src="/static/', f'src="file://{STATIC_DIR}/')
    return html


# ------------------- renderers -------------------

def _render_chromium(binary: str, html_content: str, out_path: Path) -> None:
    prepared = prepare_pdf_html(html_content, substitute_vars=False)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".html", delete=False, encoding="utf-8"
        ) as f:
            f.write(prepared)
            tmp = f.name
        cmd = [
            binary,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-pdf-header-footer",
            "--virtual-time-budget=8000",
            f"--print-to-pdf={out_path}",
            f"file://{tmp}",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0 or not Path(out_path).exists():
            raise RuntimeError(
                f"Chromium PDF render failed (exit {result.returncode}): {result.stderr.strip()[-300:]}"
            )
    finally:
        if tmp:
            Path(tmp).unlink(missing_ok=True)


def _render_weasyprint(html_content: str, out_path: Path, legacy: bool) -> None:
    # Lazy import — WeasyPrint has native deps we don't want to load at app startup
    from weasyprint import HTML

    prepared = prepare_pdf_html(html_content, substitute_vars=legacy)
    HTML(string=prepared, base_url=None).write_pdf(str(out_path))


def render_pdf(html_content: str, out_path: Path) -> None:
    engine = settings.pdf_engine
    if engine in ("auto", "chromium"):
        binary = find_chromium()
        if binary:
            _render_chromium(binary, html_content, Path(out_path))
            return
        if engine == "chromium":
            raise RuntimeError(
                "PDF_ENGINE=chromium but no Chromium binary found - set CHROMIUM_BINARY in .env"
            )

    version = _weasyprint_version()
    if not version:
        raise RuntimeError("No PDF engine available - install Chromium or WeasyPrint")
    _render_weasyprint(html_content, Path(out_path), legacy=version < (53, 0))
