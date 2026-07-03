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
    PORTAL_COOKIE_NAME,
    create_portal_cookie,
    create_session_cookie,
    get_current_user,
    get_portal_session,
    verify_password,
)
from app.clients import get_client
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
    delete_uploads,
    get_commentary,
    upsert_commentary,
    create_client,
    get_client_row,
    list_share_tokens,
    revoke_share_token,
    create_client_user,
    list_client_users,
    get_client_user,
    get_client_user_by_invite,
    touch_client_user_login,
    revoke_client_user,
    record_report_view,
    report_view_stats,
    upsert_connection,
    get_connections,
    get_connection,
    set_connection_status,
    delete_connection,
    upsert_agency_credential,
    get_agency_credentials,
    get_agency_credential,
    set_agency_credential_status,
    delete_agency_credential,
)
from app.reports import jobs
from app import connectors
from app.connectors._util import ConnectorError
from app.ingestion.parsers import PARSER_MAP, SOURCE_DEFS, summarise_parsed

# Sections that accept an optional operator note on the review screen.
REVIEW_NOTE_SECTIONS = [
    ("media", "Media coverage"),
    ("sov", "Share of voice"),
    ("execs", "Executive mentions"),
    ("sentiment", "Sentiment"),
    ("traffic", "Search & traffic"),
    ("backlinks", "Authority & social"),
    ("campaigns", "Geography"),
    ("linkedin", "LinkedIn"),
    ("technical_seo", "Technical SEO"),
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

# Cache-buster for stylesheets: changes whenever the newest CSS file changes,
# so browsers pick up redeployed styles instead of serving stale cached ones.
def _static_version() -> str:
    try:
        css_dir = STATIC_DIR / "css"
        return str(int(max(p.stat().st_mtime for p in css_dir.glob("*.css"))))
    except (ValueError, OSError):
        return "1"

env.globals["static_v"] = _static_version()


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
    record_report_view(report["client_slug"], report["period"], "share", token[:8])
    if format == "pdf":
        if not report.get("pdf_path") or not Path(report["pdf_path"]).exists():
            raise HTTPException(status_code=404, detail="PDF not available for this report")
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
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="PDF not built yet - rebuild the report")
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

    try:
        hero = get_client(slug).get("colours", {}).get("hero") or "#0C0D0E"
    except KeyError:
        hero = "#0C0D0E"

    return {
        "latest_period": latest["period"] if latest else None,
        "updated_at": latest["updated_at"][:10] if latest else None,
        "report_count": len(reports),
        "coverage": coverage,
        "sources_filled": sources_filled,
        "status": "live" if latest else "empty",
        "spark": spark[-6:],
        "hero": hero,
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
        default_period=datetime.utcnow().strftime("%Y-%m"),
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
    if get_client_row(slug):
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

@app.get("/admin/upload")
def admin_upload_get(request: Request, client: str = None):
    """Old per-card upload page — superseded by the month workspace."""
    _require_admin_or_redirect(request)
    suffix = f"?client={client}" if client else ""
    return RedirectResponse(f"/admin/workspace{suffix}", status_code=302)


@app.get("/admin/workspace", response_class=HTMLResponse)
def admin_workspace(request: Request, client: str = None, period: str = None,
                    message: str = None, error: str = None, share_url: str = None):
    """One screen per client+month: sources, build, review, share, portal."""
    _require_admin_or_redirect(request)
    clients = list_clients()
    if not clients:
        return RedirectResponse("/admin/clients/new", status_code=302)
    slug = client if client and any(c["slug"] == client for c in clients) else clients[0]["slug"]
    period = period if period and re.match(r"^\d{4}-\d{2}$", period) else datetime.utcnow().strftime("%Y-%m")

    client_config = get_client(slug)
    report = next((r for r in list_reports(slug) if r["period"] == period), None)

    shares = []
    views = {"total": 0, "last_viewed": None}
    if report:
        views = report_view_stats(slug, period)
        now = datetime.utcnow().isoformat()
        for t in list_share_tokens(report["id"]):
            expired = bool(t["expires_at"] and t["expires_at"] <= now)
            shares.append({
                **t,
                "url": f"{settings.app_url}/r/{t['token']}",
                "active": not t["revoked_at"] and not expired,
            })

    portal_members = [u for u in list_client_users(slug) if not u.get("revoked_at")]

    # Which sources can be pulled straight from an API? A source is connected
    # when some provider has both its agency key and this client's required
    # settings; search_console prefers Ahrefs GSC Insights over Google.
    conns = get_connections(slug)
    agency_creds = get_agency_credentials()
    client_cfgs = {p: _parse_config(conns.get(p)) for p in conns}
    connected_sources = {}
    for source_key in connectors.SOURCE_PROVIDERS:
        provider = connectors.pick_provider(source_key, agency_creds, client_cfgs)
        if provider:
            connected_sources[source_key] = {
                "provider": provider,
                "label": connectors.get_def(provider)["label"],
                "status": conns[provider].get("status"),
            }
    connection_cards = [
        _masked_connection_view(conns.get(d["provider"]), d, agency_creds.get(d["provider"]))
        for d in connectors.CONNECTOR_DEFS
    ]

    return _render(
        "admin/workspace.html",
        active="workspace",
        nav_clients=clients,
        clients=clients,
        client=client_config,
        selected_client=slug,
        period=period,
        source_defs=SOURCE_DEFS,
        report=report,
        shares=shares,
        views=views,
        portal_member_count=len(portal_members),
        connected_sources=connected_sources,
        connection_cards=connection_cards,
        message=message,
        error=error,
        share_url=share_url,
    )


@app.get("/admin/upload-status")
def admin_upload_status(request: Request, client: str, period: str):
    """Card states for the upload grid - lets the page rehydrate what is already uploaded."""
    _require_admin_or_redirect(request)
    out = {}
    for source_key, row in list_uploads(client, period).items():
        try:
            summary = json.loads(row.get("summary_json") or "{}")
        except (TypeError, ValueError):
            summary = {}
        out[source_key] = {
            "status": row.get("parse_status") or "error",
            "filename": row.get("filename") or "",
            "summary": summary.get("summary") or "",
            "warnings": summary.get("warnings") or [],
        }
    return JSONResponse(out)


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
        # Flag month mismatches - e.g. a June-named file dropped into July.
        name_period = re.search(r"\d{4}-\d{2}", file.filename or "")
        if name_period and name_period.group(0) != period:
            result.setdefault("warnings", []).append(
                f"File name says {name_period.group(0)} but you are uploading into {period} - check the period box"
            )
            if result.get("status") == "ok":
                result["status"] = "warning"
        upsert_upload(client_slug, period, source_key, file.filename, str(dest),
                      result["status"], result.get("row_count", 0), json.dumps(result))
        return JSONResponse(result)
    except Exception as e:
        err = {"status": "error", "summary": f"Could not parse - check this is the right file ({str(e)[:120]})", "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, file.filename, str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)


@app.post("/admin/clear-uploads")
def admin_clear_uploads(request: Request, client_slug: str = Form(...), period: str = Form(...)):
    """Reset a period: remove its upload records and the stored data files."""
    _require_admin_or_redirect(request)
    paths = delete_uploads(client_slug, period)
    removed = 0
    for p in paths:
        f = Path(p)
        # Only ever delete files inside this client+period's data folder.
        expected_dir = settings.data_dir / client_slug / period
        if f.exists() and f.parent == expected_dir:
            f.unlink()
            removed += 1
    return JSONResponse({"cleared": len(paths), "files_removed": removed})


@app.post("/admin/build-report")
async def admin_build_report_post(request: Request, client_slug: str = Form(...), period: str = Form(...)):
    """Start a build in the background. The workspace polls /admin/build-status."""
    _require_admin_or_redirect(request)
    data_dir = settings.data_dir / client_slug / period
    if not data_dir.exists() or not any(data_dir.iterdir()):
        return JSONResponse({"status": "error", "error": "No data uploaded for this period yet."})
    job = jobs.start_build(client_slug, period)
    return JSONResponse(job)


@app.get("/admin/build-status")
def admin_build_status(request: Request, client: str, period: str):
    _require_admin_or_redirect(request)
    job = jobs.get_job(client, period)
    if not job:
        return JSONResponse({"status": "idle"})
    return JSONResponse(job)


# ------------------- ADMIN REVIEW & EDIT COMMENTARY -------------------

def _blank_actions():
    return {"lean_into": [], "investigate": [], "fix_urgently": None}


@app.get("/admin/review", response_class=HTMLResponse)
def admin_review_get(request: Request, client: str = None, period: str = None, message: str = None):
    _require_admin_or_redirect(request)

    if not client or not period:
        return RedirectResponse("/admin?error=Pick+a+report+to+review+from+a+client+card", status_code=302)

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
    if not client_slug or not period:
        return RedirectResponse("/admin?error=Review+form+was+missing+client+or+period+-+try+again+from+the+client+card", status_code=302)

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

    # Stay on the review screen so the operator can keep tweaking.
    return RedirectResponse(f"/admin/review?client={client_slug}&period={period}&message=Saved+and+republished", status_code=302)


# ------------------- ADMIN API CONNECTIONS -------------------
# Secrets (API keys, service account JSON) are agency-wide and live on the
# API keys page. The workspace panel only holds per-client settings (which
# domain / property to pull). Sync and Test merge the two.

def _parse_config(row) -> dict:
    if not row:
        return {}
    try:
        return json.loads(row.get("config_json") or "{}")
    except (ValueError, TypeError):
        return {}


def _merged_config(provider: str, client_slug: str) -> dict:
    agency = _parse_config(get_agency_credential(provider))
    client = _parse_config(get_connection(client_slug, provider))
    return {**agency, **client}


def _masked_connection_view(conn_row, cdef, agency_row) -> dict:
    """Per-client connection state for the workspace panel."""
    saved = _parse_config(conn_row)
    fields = [{**f, "value": (saved.get(f["key"]) or "").strip()} for f in cdef["client_fields"]]
    return {
        "def": cdef,
        "configured": bool(conn_row),
        "status": conn_row.get("status") if conn_row else None,
        "status_detail": conn_row.get("status_detail") if conn_row else None,
        "last_synced_at": (conn_row.get("last_synced_at") or "")[:16].replace("T", " ") if conn_row else None,
        "fields": fields,
        "agency_key_set": bool(agency_row),
        "agency_key_status": agency_row.get("status") if agency_row else None,
    }


def _masked_key_view(agency_row, cdef) -> dict:
    """Agency credential state for the API keys page — secrets never echoed."""
    saved = _parse_config(agency_row)
    fields = [{**f, "has_value": bool((saved.get(f["key"]) or "").strip())} for f in cdef["agency_fields"]]
    return {
        "def": cdef,
        "configured": bool(agency_row),
        "status": agency_row.get("status") if agency_row else None,
        "status_detail": agency_row.get("status_detail") if agency_row else None,
        "fields": fields,
    }


# ---- agency keys page ----

@app.get("/admin/keys", response_class=HTMLResponse)
def admin_keys_get(request: Request, message: str = None, error: str = None):
    _require_admin_or_redirect(request)
    saved = get_agency_credentials()
    cards = [_masked_key_view(saved.get(d["provider"]), d) for d in connectors.CONNECTOR_DEFS]
    return _render(
        "admin/keys.html",
        active="keys",
        nav_clients=list_clients(),
        cards=cards,
        message=message,
        error=error,
    )


@app.post("/admin/keys/save")
async def admin_keys_save(request: Request):
    _require_admin_or_redirect(request)
    form = await request.form()
    provider = form.get("provider")
    try:
        cdef = connectors.get_def(provider)
    except KeyError:
        return RedirectResponse("/admin/keys?error=Unknown+provider", status_code=302)

    old = _parse_config(get_agency_credential(provider))
    config = {}
    for f in cdef["agency_fields"]:
        val = (form.get(f["key"]) or "").strip()
        # Secrets are write-only: blank means keep what's saved.
        if not val and f.get("secret"):
            val = old.get(f["key"], "")
        config[f["key"]] = val
    upsert_agency_credential(provider, json.dumps(config))
    return RedirectResponse(f"/admin/keys?message={cdef['label']}+key+saved+—+now+test+it", status_code=302)


@app.post("/admin/keys/test")
def admin_keys_test(request: Request, provider: str = Form(...)):
    _require_admin_or_redirect(request)
    row = get_agency_credential(provider)
    if not row:
        return RedirectResponse("/admin/keys?error=Save+the+key+first", status_code=302)
    ok, msg = connectors.test_key(provider, _parse_config(row))
    set_agency_credential_status(provider, "ok" if ok else "error", msg)
    from urllib.parse import quote
    key = "message" if ok else "error"
    return RedirectResponse(f"/admin/keys?{key}={quote(msg[:250])}", status_code=302)


@app.post("/admin/keys/delete")
def admin_keys_delete(request: Request, provider: str = Form(...)):
    _require_admin_or_redirect(request)
    delete_agency_credential(provider)
    return RedirectResponse("/admin/keys?message=Key+removed", status_code=302)


@app.get("/admin/connections")
def admin_connections_get(request: Request, client: str = None):
    """Connections live inside the client workspace now."""
    _require_admin_or_redirect(request)
    suffix = f"?client={client}" if client else ""
    return RedirectResponse(f"/admin/workspace{suffix}#connections", status_code=302)


def _connections_redirect(client_slug: str, period: str = None, message: str = None, error: str = None):
    url = f"/admin/workspace?client={client_slug}"
    if period:
        url += f"&period={period}"
    if message:
        url += f"&message={message}"
    if error:
        url += f"&error={error}"
    return RedirectResponse(url + "#connections", status_code=302)


@app.post("/admin/connections/save")
async def admin_connections_save(request: Request):
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    provider = form.get("provider")
    try:
        cdef = connectors.get_def(provider)
    except KeyError:
        return RedirectResponse(f"/admin/connections?client={client_slug}&error=Unknown+provider", status_code=302)

    config = {f["key"]: (form.get(f["key"]) or "").strip() for f in cdef["client_fields"]}
    upsert_connection(client_slug, provider, json.dumps(config))
    return _connections_redirect(client_slug, form.get("period"),
                                 message=f"{cdef['label']}+settings+saved")


@app.post("/admin/connections/test")
def admin_connections_test(request: Request, client_slug: str = Form(...), provider: str = Form(...), period: str = Form(None)):
    _require_admin_or_redirect(request)
    row = get_connection(client_slug, provider)
    if not row:
        return _connections_redirect(client_slug, period, error="Save+the+settings+first")
    if not get_agency_credential(provider):
        return _connections_redirect(client_slug, period,
                                     error="No+agency+key+for+this+provider+yet+—+add+it+on+the+API+keys+page")
    ok, msg = connectors.test_connection(provider, _merged_config(provider, client_slug))
    set_connection_status(client_slug, provider, "ok" if ok else "error", msg)
    from urllib.parse import quote
    if ok:
        return _connections_redirect(client_slug, period, message=quote(msg[:200]))
    return _connections_redirect(client_slug, period, error=quote(msg[:200]))


@app.post("/admin/connections/delete")
def admin_connections_delete(request: Request, client_slug: str = Form(...), provider: str = Form(...), period: str = Form(None)):
    _require_admin_or_redirect(request)
    delete_connection(client_slug, provider)
    return _connections_redirect(client_slug, period, message="Connection+removed")


@app.post("/admin/sync-source")
def admin_sync_source(request: Request, client_slug: str = Form(...), period: str = Form(...), source_key: str = Form(...)):
    """Pull one source from its connected API and run it through the same
    parse + record path an uploaded file takes. Returns upload-card JSON."""
    _require_admin_or_redirect(request)

    candidates = connectors.SOURCE_PROVIDERS.get(source_key) or []
    if not candidates:
        return JSONResponse({"status": "error", "summary": f"No API connector feeds {source_key}", "warnings": [], "row_count": 0})
    agency_creds = get_agency_credentials()
    client_conns = get_connections(client_slug)
    client_cfgs = {p: _parse_config(client_conns.get(p)) for p in candidates}
    provider = connectors.pick_provider(source_key, agency_creds, client_cfgs)
    if not provider:
        if not any(p in agency_creds for p in candidates):
            msg = "No agency key for this source - add one on the API keys page"
        else:
            needed = ", ".join(
                k for p in candidates if p in agency_creds
                for k in connectors.get_def(p).get("requires", {}).get(source_key, [])
            )
            msg = f"Missing client settings ({needed}) - fill them in under API connections below"
        return JSONResponse({"status": "error", "summary": msg, "warnings": [], "row_count": 0})
    config = _merged_config(provider, client_slug)

    dest_dir = settings.data_dir / client_slug / period
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{source_key}_{period}.csv"
    filename = f"API sync · {connectors.get_def(provider)['label']}"

    try:
        connectors.sync_source(provider, config, source_key, dest, period)
    except ConnectorError as e:
        err = {"status": "error", "summary": str(e)[:200], "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, filename, str(dest), "error", 0, json.dumps(err))
        set_connection_status(client_slug, provider, "error", str(e)[:200])
        return JSONResponse(err)
    except Exception as e:
        err = {"status": "error", "summary": f"Sync failed: {str(e)[:150]}", "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, filename, str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)

    try:
        label, parser = PARSER_MAP[source_key]
        data = parser(dest)
        result = summarise_parsed(source_key, data)
        upsert_upload(client_slug, period, source_key, filename, str(dest),
                      result["status"], result.get("row_count", 0), json.dumps(result))
        set_connection_status(client_slug, provider, "ok", "Last sync OK", synced=True)
        return JSONResponse(result)
    except Exception as e:
        err = {"status": "error", "summary": f"Synced but could not parse ({str(e)[:120]})", "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, filename, str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)


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
        back = f"/admin/workspace?client={client_slug}&period={period}"
        if result.returncode != 0 or "ERROR" in result.stderr:
            error_msg = result.stderr.strip() or "Fetch failed"
            return RedirectResponse(f"{back}&error=Mentions+fetch+failed:+{error_msg[:150]}", status_code=302)
        # Extract count from last output line e.g. "8 mentions written to ..."
        count_line = [l for l in output.splitlines() if "mentions written" in l]
        count = count_line[0].split()[0] if count_line else "0"
        # Register the fetched file as an upload so the workspace checklist reflects it.
        dest = settings.data_dir / client_slug / period / f"mentions_{period}.csv"
        if dest.exists():
            try:
                data = PARSER_MAP["mentions"][1](dest)
                res = summarise_parsed("mentions", data)
                upsert_upload(client_slug, period, "mentions", dest.name, str(dest),
                              res["status"], res.get("row_count", 0), json.dumps(res))
            except Exception:
                pass
        return RedirectResponse(f"{back}&message=Fetched+{count}+mentions+—+ready+to+build", status_code=302)
    except subprocess.TimeoutExpired:
        return RedirectResponse(f"/admin/workspace?client={client_slug}&period={period}&error=Mentions+fetch+timed+out", status_code=302)
    except Exception as e:
        return RedirectResponse(f"/admin/workspace?client={client_slug}&period={period}&error=Fetch+error:+{str(e)[:150]}", status_code=302)


# ------------------- ADMIN SHARE LINK -------------------

@app.post("/admin/share")
def admin_share(request: Request, report_id: int = Form(...), redirect: str = Form(None)):
    _require_admin_or_redirect(request)
    report = get_report(report_id)
    if not report:
        return RedirectResponse("/admin?error=Report+not+found", status_code=302)

    token = secrets.token_urlsafe(24)
    expires = (datetime.utcnow() + timedelta(days=90)).isoformat()
    create_share_token(report_id, token, expires)
    share_url = f"{settings.app_url}/r/{token}"
    if redirect == "workspace":
        return RedirectResponse(
            f"/admin/workspace?client={report['client_slug']}&period={report['period']}&share_url={share_url}",
            status_code=302,
        )
    return RedirectResponse(f"/admin?share_url={share_url}", status_code=302)


@app.post("/admin/share/revoke")
def admin_share_revoke(request: Request, token: str = Form(...), client: str = Form(None), period: str = Form(None)):
    _require_admin_or_redirect(request)
    revoke_share_token(token)
    if client and period:
        return RedirectResponse(f"/admin/workspace?client={client}&period={period}&message=Link+revoked", status_code=302)
    return RedirectResponse("/admin?message=Link+revoked", status_code=302)


# ------------------- CLIENT PORTAL -------------------

def _portal_user(request: Request):
    """Resolve the portal cookie to a live (non-revoked) client user, or None."""
    sess = get_portal_session(request)
    if not sess:
        return None
    user = get_client_user(sess["uid"])
    if not user or user.get("revoked_at") or user["client_slug"] != sess["c"]:
        return None
    return user


@app.get("/portal/join/{token}")
def portal_join(token: str):
    user = get_client_user_by_invite(token)
    if not user:
        return _render("portal/locked.html", reason="expired")
    touch_client_user_login(user["id"])
    resp = RedirectResponse("/portal", status_code=302)
    resp.set_cookie(
        PORTAL_COOKIE_NAME,
        create_portal_cookie(user["id"], user["client_slug"]),
        max_age=60 * 60 * 24 * 30,
        httponly=True,
        secure=settings.app_env == "production",
        samesite="lax",
    )
    return resp


@app.get("/portal", response_class=HTMLResponse)
def portal_home(request: Request):
    user = _portal_user(request)
    if not user:
        return _render("portal/locked.html", reason="signed_out")

    slug = user["client_slug"]
    client = get_client(slug)
    reports = []
    for r in list_reports(slug):
        html_path = r.get("html_path")
        if not html_path or not Path(html_path).exists():
            continue
        commentary = get_commentary(slug, r["period"]) or {}
        try:
            dt = datetime.strptime(r["period"], "%Y-%m")
            month_abbr, year = dt.strftime("%b"), dt.strftime("%Y")
        except ValueError:
            month_abbr, year = r["period"], ""
        reports.append({
            **r,
            "period_display": _period_display_safe(r["period"]),
            "month_abbr": month_abbr,
            "year": year,
            "headline": commentary.get("headline") or "Performance Report",
            "standfirst": commentary.get("standfirst") or "",
            "has_pdf": bool(r.get("pdf_path") and Path(r["pdf_path"]).exists()),
        })

    return _render("portal/home.html", client=client, user=user, reports=reports)


@app.get("/portal/report/{period}", response_class=HTMLResponse)
def portal_report(request: Request, period: str):
    user = _portal_user(request)
    if not user:
        return _render("portal/locked.html", reason="signed_out")
    slug = user["client_slug"]
    html_path = settings.reports_out_dir / slug / f"{period}.html"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Report not found")
    record_report_view(slug, period, "portal", user["email"])
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.get("/portal/report/{period}/pdf")
def portal_report_pdf(request: Request, period: str):
    user = _portal_user(request)
    if not user:
        return _render("portal/locked.html", reason="signed_out")
    slug = user["client_slug"]
    pdf_path = settings.reports_out_dir / slug / f"{period}.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not available")
    record_report_view(slug, period, "portal", user["email"])
    return FileResponse(pdf_path, media_type="application/pdf", filename=f"{slug}-{period}.pdf")


@app.get("/portal/logout")
def portal_logout():
    resp = RedirectResponse("/portal", status_code=302)
    resp.delete_cookie(PORTAL_COOKIE_NAME)
    return resp


def _period_display_safe(period: str) -> str:
    try:
        return datetime.strptime(period, "%Y-%m").strftime("%B %Y")
    except ValueError:
        return period


# ------------------- ADMIN PORTAL MANAGEMENT -------------------

@app.get("/admin/portal", response_class=HTMLResponse)
def admin_portal_get(request: Request, client: str = None, message: str = None, error: str = None, invite_url: str = None):
    _require_admin_or_redirect(request)
    clients = list_clients()
    selected = client or (clients[0]["slug"] if clients else None)
    members = list_client_users(selected) if selected else []
    for m in members:
        m["invite_url"] = f"{settings.app_url}/portal/join/{m['invite_token']}"
    return _render(
        "admin/portal.html",
        active="portal",
        nav_clients=clients,
        clients=clients,
        selected_client=selected,
        members=members,
        message=message,
        error=error,
        invite_url=invite_url,
    )


@app.post("/admin/portal/add")
def admin_portal_add(request: Request, client_slug: str = Form(...), email: str = Form(...), name: str = Form(None)):
    _require_admin_or_redirect(request)
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return RedirectResponse(f"/admin/portal?client={client_slug}&error=Enter+a+valid+email", status_code=302)
    token = secrets.token_urlsafe(24)
    try:
        create_client_user(client_slug, email, (name or "").strip(), token)
    except Exception:
        return RedirectResponse(f"/admin/portal?client={client_slug}&error=That+email+already+has+access", status_code=302)
    invite_url = f"{settings.app_url}/portal/join/{token}"
    return RedirectResponse(f"/admin/portal?client={client_slug}&invite_url={invite_url}", status_code=302)


@app.post("/admin/portal/revoke")
def admin_portal_revoke(request: Request, user_id: int = Form(...), client_slug: str = Form(...)):
    _require_admin_or_redirect(request)
    revoke_client_user(user_id)
    return RedirectResponse(f"/admin/portal?client={client_slug}&message=Access+revoked", status_code=302)
