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
)
from app.ingestion.parsers import PARSER_MAP, SOURCE_DEFS, summarise_parsed
from app.reports.builder import build_report


app = FastAPI(title="Digital Footprints Reporting")

STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)


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

@app.get("/admin", response_class=HTMLResponse)
def admin_dashboard(request: Request, message: str = None, error: str = None, share_url: str = None):
    _require_admin_or_redirect(request)
    clients = list_clients()
    all_reports = list_reports()
    reports_by_client = {}
    for r in all_reports:
        reports_by_client.setdefault(r["client_slug"], []).append(r)
    return _render(
        "admin/dashboard.html",
        clients=clients,
        reports_by_client=reports_by_client,
        message=message,
        error=error,
        share_url=share_url,
    )


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
        return RedirectResponse(f"/admin?message=Report+built+for+{client_slug}+{period}", status_code=302)
    except Exception as e:
        return RedirectResponse(f"/admin?error=Build+failed:+{str(e)[:200]}", status_code=302)


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
