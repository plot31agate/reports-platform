"""Digital Footprints Reporting Platform — FastAPI app.

Routes:
  Public:
    GET  /                             landing / redirect to admin
    GET  /health                       health check
    GET  /r/{token}                    shareable link (no auth)
    GET  /c/{slug}/{period}            report view (admin only)
    GET  /c/{slug}/{period}?format=pdf report PDF (admin only)

  Admin:
    GET  /admin/login
    POST /admin/login
    GET  /admin/logout
    GET  /admin                        dashboard
    GET  /admin/upload
    POST /admin/upload
    POST /admin/share                  generate share link for a report
"""
import json
import re
import secrets
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, Request, Form, UploadFile, File, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.auth import (
    COOKIE_NAME,
    create_session_cookie,
    get_current_user,
    verify_password,
)
from app.clients import CLIENTS, get_client
from app.config import settings
from app.db import (
    create_share_token,
    get_report,
    get_report_by_token,
    init_db,
    list_clients,
    list_reports,
    upsert_report,
    upsert_upload,
    list_uploads,
    get_commentary,
    upsert_commentary,
    create_client,
    get_client_row,
)
from app.ingestion.parsers import PARSER_MAP, SOURCE_DEFS, summarise_parsed

# Sections that accept an optional operator note on the review screen.
REVIEW_NOTE_SECTIONS = [
    ("media", "Media coverage"),
    ("sov", "Share of voice"),
    ("execs", "Executive mentions"),
    ("sentiment", "Sentiment tracking"),
    ("traffic", "Website traffic"),
    ("backlinks", "Referring domains"),
    ("campaigns", "Campaigns & events"),
    ("linkedin", "LinkedIn"),
    ("technical_seo", "Technical SEO & Site Health"),
]
from app.reports.builder import build_report


app = FastAPI(title="Digital Footprints Reporting")

STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)
env.filters["thousands"] = lambda v: f"{v:,}" if isinstance(v, (int, float)) else v


@app.on_event("startup")
def startup():
    init_db()


def _render(template: str, **ctx) -> HTMLResponse:
    tpl = env.get_template(template)
    return HTMLResponse(tpl.render(**ctx))


def _require_admin_or_redirect(request: Request):
    user = get_current_user(request)
    if not user or user != settings.admin_username:
        raise HTTPException(status_code=303, headers={"Location": "/admin/login"})
    return user


# ------------------- PUBLIC -------------------

@app.get("/")
def root(request: Request):
    user = get_current_user(request)
    if user:
        return RedirectResponse("/admin", status_code=302)
    return RedirectResponse("/admin/login", status_code=302)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/r/{token}", response_class=HTMLResponse)
def share_link(token: str, format: str = None):
    report = get_report_by_token(token)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found or link expired")
    if format == "pdf":
        return FileResponse(report["pdf_path"], media_type="application/pdf",
                            filename=f"{report['client_slug']}-{report['period']}.pdf")
    return HTMLResponse(Path(report["html_path"]).read_text(encoding="utf-8"))


@app.get("/c/{slug}/{period}", response_class=HTMLResponse)
def report_view(request: Request, slug: str, period: str, format: str = None):
    _require_admin_or_redirect(request)
    out_dir = settings.reports_out_dir / slug
    html_path = out_dir / f"{period}.html"
    pdf_path = out_dir / f"{period}.pdf"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Report not built yet")
    if format == "pdf":
        return FileResponse(pdf_path, media_type="application/pdf",
                            filename=f"{slug}-{period}.pdf")
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ------------------- ADMIN AUTH -------------------

@app.get("/admin/login", response_class=HTMLResponse)
def admin_login_get(request: Request):
    return _render("admin/login.html")


@app.post("/admin/login")
def admin_login_post(username: str = Form(...), password: str = Form(...)):
    if username != settings.admin_username or not verify_password(password, settings.admin_password_hash):
        return _render("admin/login.html", error="Invalid credentials.")
    resp = RedirectResponse("/admin", status_code=302)
    resp.set_cookie(
        COOKIE_NAME,
        create_session_cookie(username),
        max_age=settings.session_max_age_seconds,
        httponly=True,
        secure=settings.app_env == "production",
        samesite="lax",
    )
    return resp


@app.get("/admin/logout")
def admin_logout():
    resp = RedirectResponse("/admin/login", status_code=302)
    resp.delete_cookie(COOKIE_NAME)
    return resp


# ------------------- ADMIN DASHBOARD -------------------

def _client_kpis(slug: str, reports: list) -> dict:
    """Derive light dashboard KPIs for a client from stored reports + uploads."""
    reports = sorted(reports, key=lambda r: r["period"], reverse=True)
    latest = reports[0] if reports else None

    coverage = None
    sources_filled = 0
    spark = []  # coverage per period, oldest -> newest, for a mini bar chart

    for r in sorted(reports, key=lambda r: r["period"]):
        ups = list_uploads(slug, r["period"])
        mentions = ups.get("mentions")
        cov = mentions["row_count"] if mentions and mentions.get("row_count") else 0
        spark.append({"period": r["period"], "coverage": cov})

    if latest:
        ups = list_uploads(slug, latest["period"])
        sources_filled = sum(1 for u in ups.values() if u.get("parse_status") in ("ok", "warning"))
        m = ups.get("mentions")
        coverage = m["row_count"] if m and m.get("row_count") else 0

    return {
        "latest_period": latest["period"] if latest else None,
        "updated_at": latest["updated_at"][:10] if latest else None,
        "report_count": len(reports),
        "coverage": coverage,
        "sources_filled": sources_filled,
        "status": "live" if latest else "empty",
        "spark": spark[-6:],
    }


@app.get("/admin", response_class=HTMLResponse)
def admin_dashboard(request: Request, message: str = None, error: str = None, share_url: str = None):
    _require_admin_or_redirect(request)
    clients = list_clients()
    all_reports = list_reports()
    reports_by_client = {}
    for r in all_reports:
        reports_by_client.setdefault(r["client_slug"], []).append(r)

    kpis_by_client = {c["slug"]: _client_kpis(c["slug"], reports_by_client.get(c["slug"], [])) for c in clients}

    total_reports = len(all_reports)
    total_coverage = sum((k["coverage"] or 0) for k in kpis_by_client.values())
    active_clients = sum(1 for k in kpis_by_client.values() if k["status"] == "live")
    latest_activity = max((k["updated_at"] for k in kpis_by_client.values() if k["updated_at"]), default=None)

    overview = {
        "clients": len(clients),
        "active_clients": active_clients,
        "reports": total_reports,
        "coverage": total_coverage,
        "latest_activity": latest_activity,
        "source_count": len(SOURCE_DEFS),
    }

    return _render(
        "admin/dashboard.html",
        active="dashboard",
        nav_clients=clients,
        clients=clients,
        reports_by_client={k: sorted(v, key=lambda r: r["period"], reverse=True) for k, v in reports_by_client.items()},
        kpis_by_client=kpis_by_client,
        overview=overview,
        message=message,
        error=error,
        share_url=share_url,
    )


# ------------------- ADMIN NEW CLIENT -------------------

def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or "client"


@app.get("/admin/clients/new", response_class=HTMLResponse)
def admin_new_client_get(request: Request, error: str = None):
    _require_admin_or_redirect(request)
    return _render(
        "admin/new_client.html",
        active="dashboard",
        nav_clients=list_clients(),
        error=error,
    )


@app.post("/admin/clients/new")
async def admin_new_client_post(request: Request):
    _require_admin_or_redirect(request)
    form = await request.form()
    display_name = (form.get("display_name") or "").strip()
    if not display_name:
        return RedirectResponse("/admin/clients/new?error=Enter+a+client+name", status_code=302)

    slug = _slugify(form.get("slug") or display_name)
    if slug in CLIENTS or get_client_row(slug):
        return RedirectResponse(f"/admin/clients/new?error=Client+{slug}+already+exists", status_code=302)

    def _lines(key):
        raw = form.get(key) or ""
        return [x.strip() for x in re.split(r"[\n,]+", raw) if x.strip()]

    hero = (form.get("hero_colour") or "#FF4F40").strip()
    accent = (form.get("accent_colour") or "#00D8AE").strip()
    config = {
        "brandline": (form.get("brandline") or "").strip(),
        "tagline": (form.get("tagline") or "").strip(),
        "colours": {"coral": hero, "hero": hero, "teal": accent, "accent": accent},
        "executives": _lines("executives"),
        "competitors": _lines("competitors"),
        "regions_of_interest": _lines("regions"),
    }
    sc = (form.get("sentiment_context") or "").strip()
    if sc:
        config["sentiment_context"] = sc

    create_client(slug, display_name, json.dumps(config))
    return RedirectResponse(f"/admin?message=Client+{display_name}+added", status_code=302)


# ------------------- ADMIN UPLOAD -------------------

@app.get("/admin/upload", response_class=HTMLResponse)
def admin_upload_get(request: Request, client: str = None):
    _require_admin_or_redirect(request)
    default_period = datetime.utcnow().strftime("%Y-%m")
    return _render(
        "admin/upload.html",
        clients=list_clients(),
        selected_client=client or "sportingtech",
        default_period=default_period,
        source_defs=SOURCE_DEFS,
    )


@app.post("/admin/upload")
async def admin_upload_post(
    request: Request,
    client_slug: str = Form(...),
    period: str = Form(...),
    action: str = Form(...),
    files: list[UploadFile] = File(...),
):
    _require_admin_or_redirect(request)

    if client_slug not in CLIENTS:
        return _render("admin/upload.html",
                       clients=list_clients(),
                       selected_client=client_slug,
                       default_period=period,
                       file_hints=[(k, label) for k, (label, _) in PARSER_MAP.items()],
                       error=f"Unknown client: {client_slug}")

    # Save files
    upload_dir = settings.data_dir / client_slug / period
    upload_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for f in files:
        dest = upload_dir / f.filename
        content = await f.read()
        dest.write_bytes(content)
        saved.append(f.filename)

    if action == "upload_only":
        return RedirectResponse(
            f"/admin?message=Uploaded+{len(saved)}+files+to+{client_slug}/{period}",
            status_code=302,
        )

    # Build the report
    try:
        result = build_report(client_slug, period)
        return RedirectResponse(
            f"/admin?message=Report+built+for+{client_slug}+{period}",
            status_code=302,
        )
    except Exception as e:
        return RedirectResponse(
            f"/admin?error=Build+failed:+{str(e)[:200]}",
            status_code=302,
        )


@app.post("/admin/parse-upload")
async def admin_parse_upload(
    request: Request,
    source_key: str = Form(...),
    client_slug: str = Form(...),
    period: str = Form(...),
    file: UploadFile = File(...),
):
    _require_admin_or_redirect(request)

    if source_key not in PARSER_MAP:
        return JSONResponse({"status": "error", "summary": f"Unknown source: {source_key}", "warnings": [], "row_count": 0})

    label, parser = PARSER_MAP[source_key]
    ext = Path(file.filename).suffix.lower() or ".csv"
    dest_dir = settings.data_dir / client_slug / period
    dest_dir.mkdir(parents=True, exist_ok=True)
    canonical = f"{source_key}_{period}{ext}"
    dest = dest_dir / canonical
    content = await file.read()
    dest.write_bytes(content)

    try:
        data = parser(dest)
        result = summarise_parsed(source_key, data)
        upsert_upload(client_slug, period, source_key, file.filename, str(dest),
                      result["status"], result.get("row_count", 0), json.dumps(result))
        return JSONResponse(result)
    except Exception as e:
        err = {"status": "error", "summary": f"Could not parse - check this is the right file ({str(e)[:120]})", "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, file.filename, str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)


@app.post("/admin/build-report")
async def admin_build_report_post(request: Request, client_slug: str = Form(...), period: str = Form(...)):
    _require_admin_or_redirect(request)
    try:
        build_report(client_slug, period)
        # Hand off to the review + edit commentary screen.
        return RedirectResponse(f"/admin/review?client={client_slug}&period={period}", status_code=302)
    except Exception as e:
        return RedirectResponse(f"/admin?error=Build+failed:+{str(e)[:200]}", status_code=302)


# ------------------- ADMIN REVIEW & EDIT COMMENTARY -------------------

def _blank_actions():
    return {"lean_into": [], "investigate": [], "fix_urgently": None}


@app.get("/admin/review", response_class=HTMLResponse)
def admin_review_get(request: Request, client: str, period: str, message: str = None):
    _require_admin_or_redirect(request)

    row = get_commentary(client, period)
    if row is None:
        # No build has happened yet — send them back to upload.
        return RedirectResponse(f"/admin/upload?client={client}", status_code=302)

    from app.reports.builder import build_context, _env

    # Assemble the real report context, then flip it into editable mode so the
    # comment boxes render exactly where they appear in the finished report.
    context = build_context(client, period)

    actions = context["commentary"].get("actions") or _blank_actions()
    lean = (actions.get("lean_into") or []) + [{"action": "", "why": ""}] * 3
    invest = (actions.get("investigate") or []) + [{"action": "", "why": ""}] * 3
    fix = actions.get("fix_urgently") or {"action": "", "why": ""}

    html_path = settings.reports_out_dir / client / f"{period}.html"
    preview_url = f"/c/{client}/{period}" if html_path.exists() else None

    context.update({
        "editable": True,
        "edit_lean": lean[:3],
        "edit_invest": invest[:3],
        "edit_fix": fix,
        "preview_url": preview_url,
        "message": message,
    })

    html = _env().get_template("report.html").render(**context)
    return HTMLResponse(html)


@app.post("/admin/review")
async def admin_review_post(request: Request):
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    period = form.get("period")

    headline = (form.get("headline") or "").strip() or "Performance Report"
    standfirst = (form.get("standfirst") or "").strip()

    notes = {}
    for key, _label in REVIEW_NOTE_SECTIONS:
        val = (form.get(f"note_{key}") or "").strip()
        if val:
            notes[key] = val

    def _bucket(prefix):
        items = []
        for i in range(3):
            action = (form.get(f"{prefix}_{i}_action") or "").strip()
            why = (form.get(f"{prefix}_{i}_why") or "").strip()
            if action:
                items.append({"action": action, "why": why})
        return items

    fix_action = (form.get("fix_0_action") or "").strip()
    fix_why = (form.get("fix_0_why") or "").strip()
    actions = {
        "lean_into": _bucket("lean_into"),
        "investigate": _bucket("investigate"),
        "fix_urgently": {"action": fix_action, "why": fix_why} if fix_action else None,
    }

    upsert_commentary(
        client_slug, period, headline, standfirst,
        json.dumps(notes), json.dumps(actions),
    )

    # Regenerate HTML + PDF with the edited commentary.
    try:
        build_report(client_slug, period)
    except Exception as e:
        return RedirectResponse(f"/admin/review?client={client_slug}&period={period}&message=Saved+but+build+failed:+{str(e)[:120]}", status_code=302)

    return RedirectResponse(f"/admin?message=Report+updated+for+{client_slug}+{period}", status_code=302)


# ------------------- ADMIN FETCH MENTIONS -------------------

@app.post("/admin/fetch-mentions")
def admin_fetch_mentions(request: Request, client_slug: str = Form(...), period: str = Form(...)):
    _require_admin_or_redirect(request)

    script = Path(__file__).parent.parent / "scripts" / "fetch_mentions.py"
    try:
        result = subprocess.run(
            [sys.executable, str(script), "--period", period, "--client", client_slug],
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout.strip()
        if result.returncode != 0 or "ERROR" in result.stderr:
            error_msg = result.stderr.strip() or "Fetch failed"
            return RedirectResponse(
                f"/admin?error=Mentions+fetch+failed:+{error_msg[:150]}",
                status_code=302,
            )
        # Extract count from last output line e.g. "8 mentions written to ..."
        count_line = [l for l in output.splitlines() if "mentions written" in l]
        count = count_line[0].split()[0] if count_line else "0"
        return RedirectResponse(
            f"/admin?message=Fetched+{count}+mentions+for+{client_slug}/{period}+—+ready+to+build",
            status_code=302,
        )
    except subprocess.TimeoutExpired:
        return RedirectResponse("/admin?error=Mentions+fetch+timed+out", status_code=302)
    except Exception as e:
        return RedirectResponse(f"/admin?error=Fetch+error:+{str(e)[:150]}", status_code=302)


# ------------------- ADMIN SHARE LINK -------------------

@app.post("/admin/share")
def admin_share(request: Request, report_id: int = Form(...)):
    _require_admin_or_redirect(request)
    report = get_report(report_id)
    if not report:
        return RedirectResponse("/admin?error=Report+not+found", status_code=302)

    token = secrets.token_urlsafe(24)
    expires = (datetime.utcnow() + timedelta(days=90)).isoformat()
    create_share_token(report_id, token, expires)
    share_url = f"{settings.app_url}/r/{token}"
    return RedirectResponse(f"/admin?share_url={share_url}", status_code=302)
