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
import shutil
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
    clear_commentary_text,
    set_mention_overrides,
    create_client,
    delete_client,
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
    report_index,
    report_view_stats,
    get_report_layout,
    save_report_layout,
    update_client_config_key,
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
    get_client_agency,
    patch_client_agency,
    get_client_secret,
    create_client_secret,
    update_client_secret,
    delete_client_secret,
    touch_secret_reveal,
    create_hq_build_job,
    get_latest_hq_build_job,
    get_hq_build_job,
    cancel_hq_build_job,
)
from app import vault
from app.reports import jobs
from app import connectors
from app.connectors._util import ConnectorError
from app.ingestion.parsers import PARSER_MAP, SOURCE_DEFS, SOURCE_GROUPS, summarise_parsed
from app.reports.sections import SECTION_DEFS, enabled_sections, enabled_source_keys, ALL_SECTION_KEYS

# Sections that accept an optional operator note on the review screen.
REVIEW_NOTE_SECTIONS = [
    ("intro", "Executive summary"),
    ("mom", "Month on month"),
    ("media", "Media coverage"),
    ("sov", "Share of voice"),
    ("execs", "Executive mentions"),
    ("sentiment", "Sentiment"),
    ("traffic", "Search & traffic"),
    ("trends", "Daily trends"),
    ("backlinks", "Authority & social"),
    ("campaigns", "Geography"),
    ("linkedin", "LinkedIn"),
    ("social", "Facebook & Instagram"),
    ("tiktok", "TikTok"),
    ("influencers", "Influencer activity"),
    ("misc", "Misc"),
    ("technical_seo", "Technical SEO"),
]
from app.reports.builder import build_report, layout_from_notes, LAYOUT_KEYS


app = FastAPI(title="Digital Footprints Reporting")

STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ------------------- AGENCY HQ (master client portal) -------------------
# Agency HQ is a built Vite app served here as a new folder under the reports
# app: the same domain and login as the reporting dashboards, no separate
# hosting. Its data comes from a live snapshot route (below) that reads the
# same reporting.db, so the roster is always current — not baked at build time.
AGENCY_DIST = Path(__file__).parent.parent / "agency" / "dist"


# Per-provider client fields whose values are secret (write-only in any UI).
_SECRET_CLIENT_FIELDS = {
    d["provider"]: {f["key"] for f in d["client_fields"] if f.get("secret")}
    for d in connectors.CONNECTOR_DEFS
}


def _setup_meta() -> dict:
    """Static setup vocabulary the Agency HQ wizard renders from: the report
    sections on offer and each connector's per-client fields (secrets flagged,
    values never included)."""
    return {
        "section_defs": [
            {"key": d["key"], "label": d["label"], "hint": d["hint"], "default": d["default"]}
            for d in SECTION_DEFS
        ],
        "connectors": [
            {
                "provider": d["provider"],
                "label": d["label"],
                "blurb": d["blurb"],
                "client_fields": [
                    {k: f.get(k) for k in ("key", "label", "type", "placeholder", "hint", "secret") if f.get(k) is not None}
                    for f in d["client_fields"]
                ],
            }
            for d in connectors.CONNECTOR_DEFS
        ],
    }


def _build_agency_snapshot() -> dict:
    """The state Agency HQ's roster needs, straight from the core DB. Mirrors
    scripts/agency_snapshot.py, but live per-request instead of a static file."""
    from app.db import get_conn

    clients = []
    with get_conn() as conn:
        for c in conn.execute(
            "SELECT slug, display_name, config_json, created_at FROM clients ORDER BY display_name"
        ).fetchall():
            slug = c["slug"]
            try:
                cfg = json.loads(c["config_json"] or "{}")
            except (ValueError, TypeError):
                cfg = {}
            reports = [
                {"period": r["period"], "status": r["status"], "updated_at": r["updated_at"]}
                for r in conn.execute(
                    "SELECT period, status, updated_at FROM reports WHERE client_slug=? ORDER BY period DESC",
                    (slug,),
                ).fetchall()
            ]
            connections = []
            conn_settings = {}
            for r in conn.execute(
                "SELECT provider, status, status_detail, last_synced_at, config_json FROM client_connections WHERE client_slug=?",
                (slug,),
            ).fetchall():
                connections.append({
                    "provider": r["provider"],
                    "status": r["status"],
                    "detail": r["status_detail"],
                    "last_synced_at": r["last_synced_at"],
                })
                try:
                    saved = json.loads(r["config_json"] or "{}")
                except (ValueError, TypeError):
                    saved = {}
                secret_keys = _SECRET_CLIENT_FIELDS.get(r["provider"], set())
                # Secrets never leave the server — report only that one is set.
                conn_settings[r["provider"]] = {
                    k: ("•set•" if k in secret_keys and v else v)
                    for k, v in saved.items() if isinstance(v, str)
                }
            secrets = [
                {
                    "id": r["id"],
                    "label": r["label"],
                    "login_url": r["login_url"],
                    "username": r["username"],
                    "has_password": bool(r["secret_cipher"]),
                    "notes": r["notes"],
                    "updated_by": r["updated_by"],
                    "updated_at": r["updated_at"],
                    "last_revealed_at": r["last_revealed_at"],
                    "last_revealed_by": r["last_revealed_by"],
                }
                for r in conn.execute(
                    "SELECT * FROM client_secrets WHERE client_slug=? ORDER BY label",
                    (slug,),
                ).fetchall()
            ]
            # Built-in portal members (Client HQ on the app itself), invite
            # links included — the whole agency API is admin-gated.
            portal_users = [
                {
                    "id": r["id"], "email": r["email"], "name": r["name"],
                    "invite_url": f"{settings.app_url}/portal/join/{r['invite_token']}",
                    "last_login_at": r["last_login_at"], "revoked_at": r["revoked_at"],
                }
                for r in conn.execute(
                    "SELECT * FROM client_users WHERE client_slug=? ORDER BY created_at", (slug,),
                ).fetchall()
            ]
            agency = cfg.get("agency") if isinstance(cfg.get("agency"), dict) else {}
            clients.append({
                "slug": slug,
                "display_name": c["display_name"],
                "source": "db",
                "created_at": c["created_at"],
                "tagline": cfg.get("tagline") or cfg.get("brandline") or "",
                "agency": agency,
                "reports": reports,
                "latest_report": reports[0] if reports else None,
                "connections": connections,
                "secrets": secrets,
                "portal_users": portal_users,
                # The reporting-core setup Agency HQ can now read AND write —
                # the same keys the workspace and report builder consume.
                "setup": {
                    "about": cfg.get("about") or "",
                    "sections": enabled_sections(cfg),
                    "competitors": cfg.get("competitors") or [],
                    "executives": cfg.get("executives") or [],
                    "sentiment_context": cfg.get("sentiment_context") or "",
                    "report_focus": cfg.get("report_focus") or "",
                    "connections": conn_settings,
                },
            })
    from app.vault import vault_ready
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "source": "reporting.db",
        "vault_ready": vault_ready(),
        "assist_ready": bool(settings.anthropic_api_key),
        "agency_keys": sorted(get_agency_credentials().keys()),
        "meta": _setup_meta(),
        "clients": clients,
    }


# Registered BEFORE the /agency static mount so it wins over any baked
# snapshot.json inside the built app. Admin-only: the shell is harmless static
# JS, but the client data stays behind the same login as the reporting admin.
@app.get("/agency/snapshot.json")
def agency_snapshot(request: Request):
    user = get_current_user(request)
    if not user or user != settings.admin_username:
        return JSONResponse({"error": "auth", "clients": []}, status_code=401)
    return JSONResponse(_build_agency_snapshot())


# ------------------- AGENCY HQ WRITE API -------------------
# JSON endpoints the Agency HQ SPA calls to make the roster and vault real —
# one source of truth in reporting.db instead of a per-browser overlay. All
# admin-gated by the same session as the reporting dashboards.

def _agency_admin(request: Request):
    user = get_current_user(request)
    if not user or user != settings.admin_username:
        raise HTTPException(status_code=401, detail="Not signed in")
    return user


def _agency_client_payload(slug: str) -> dict:
    """One client's live agency view for optimistic UI after a write."""
    row = get_client_row(slug)
    if not row:
        raise HTTPException(status_code=404, detail="Unknown client")
    return {"slug": slug, "display_name": row["display_name"], "agency": get_client_agency(slug)}


@app.post("/agency/api/clients")
async def agency_create_client(request: Request):
    _agency_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A client name is required")
    slug = _slugify(body.get("slug") or name)
    # Uniqueness: bump -2, -3… like the front end used to.
    base, n = slug, 2
    while get_client_row(slug):
        slug = f"{base}-{n}"
        n += 1

    from app.agency_roster import default_agency_block
    kind = body.get("kind") if body.get("kind") in ("client-hq", "reporting") else "reporting"
    block = default_agency_block(kind, (body.get("owner") or "Unassigned").strip() or "Unassigned")
    for key in ("website", "portalUrl", "portalStatus"):
        if body.get(key) is not None:
            block[key] = body[key]
    if isinstance(body.get("cadence"), dict):
        block["cadence"] = {**block["cadence"], **body["cadence"]}
    if isinstance(body.get("strategy"), dict):
        block["strategy"] = body["strategy"]

    config: dict = {"agency": block}
    create_client(slug, name, json.dumps(config))

    # The wizard can hand the full reporting-core setup in the same POST, so a
    # new client lands configured, not just named.
    if isinstance(body.get("settings"), dict):
        _apply_client_settings(slug, body["settings"])
    if isinstance(body.get("connections"), dict):
        for provider, fields in body["connections"].items():
            if isinstance(fields, dict):
                try:
                    _save_client_connection(slug, provider, fields)
                except KeyError:
                    pass  # unknown provider in the payload — skip, don't fail the create
    return JSONResponse(_agency_client_payload(slug))


# The reporting-core config keys Agency HQ may write. Lists are lists of
# strings; the rest are free text. Everything else in config_json is off-limits
# from this API (colours, agency block has its own endpoints, etc.).
_SETTINGS_LIST_KEYS = ("competitors", "executives")
_SETTINGS_TEXT_KEYS = ("about", "sentiment_context", "report_focus")


def _apply_client_settings(slug: str, body: dict) -> list:
    """Write the recognised setup keys from `body` into the client's config.
    Returns the list of keys actually written."""
    written = []
    for key in _SETTINGS_LIST_KEYS:
        if key in body and isinstance(body[key], list):
            update_client_config_key(slug, key, [str(x).strip() for x in body[key] if str(x).strip()])
            written.append(key)
    for key in _SETTINGS_TEXT_KEYS:
        if key in body and isinstance(body[key], str):
            update_client_config_key(slug, key, body[key].strip())
            written.append(key)
    if "sections" in body and isinstance(body["sections"], list):
        chosen = [k for k in ALL_SECTION_KEYS if k in body["sections"]]
        if chosen:
            update_client_config_key(slug, "sections", chosen)
            written.append("sections")
    return written


def _save_client_connection(slug: str, provider: str, fields: dict) -> None:
    """Upsert one provider's per-client connection settings (JSON API twin of
    admin_connections_save). Blank secrets keep their stored value."""
    cdef = connectors.get_def(provider)  # KeyError on unknown provider
    old = _parse_config(get_connection(slug, provider))
    config = {}
    for f in cdef["client_fields"]:
        val = str(fields.get(f["key"]) or "").strip()
        if f.get("secret") and (not val or val == "•set•"):
            val = old.get(f["key"], "")
        config[f["key"]] = val
    # Nothing filled and nothing stored → don't create an empty connection row.
    if not any(v for v in config.values()) and not old:
        return
    upsert_connection(slug, provider, json.dumps(config))


@app.patch("/agency/api/clients/{slug}/settings")
async def agency_patch_settings(slug: str, request: Request):
    """Save the client's reporting-core setup (sections, competitors,
    executives, briefs) — the keys the workspace and report builder read."""
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    _apply_client_settings(slug, body)
    return JSONResponse(_agency_client_payload(slug))


@app.put("/agency/api/clients/{slug}/connections/{provider}")
async def agency_put_connection(slug: str, provider: str, request: Request):
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    try:
        _save_client_connection(slug, provider, body if isinstance(body, dict) else {})
    except KeyError:
        raise HTTPException(status_code=400, detail="Unknown provider")
    return JSONResponse({"ok": True})


@app.post("/agency/api/clients/{slug}/connections/{provider}/test")
def agency_test_connection(slug: str, provider: str, request: Request):
    """Test one client connection and stamp its status — same path as the
    workspace Test button, returned as JSON for the SPA."""
    _agency_admin(request)
    try:
        cdef = connectors.get_def(provider)
    except KeyError:
        raise HTTPException(status_code=400, detail="Unknown provider")
    saved = _parse_config(get_connection(slug, provider))
    client_has_secret = any(
        f.get("secret") and (saved.get(f["key"]) or "").strip() for f in cdef["client_fields"]
    )
    if not get_agency_credential(provider) and not client_has_secret:
        return JSONResponse({"ok": False, "message": "No agency key for this provider yet — add it on the API keys page."})
    ok, msg = connectors.test_connection(provider, _merged_config(provider, slug))
    set_connection_status(slug, provider, "ok" if ok else "error", msg)
    return JSONResponse({"ok": ok, "message": msg[:300]})


# ---- live estate health: read the real sites and portals ----
# Agency HQ shouldn't be told whether a client's site or Client HQ portal is
# up — it should look. A check GETs the URL (auth-gated 401/403 still counts
# as up), and a portal that publishes <portalUrl>/agency-status.json feeds its
# real field state (pending approvals, content due) into the same task engine.
# The whole `live` block is replaced by what was measured, so nothing in it is
# ever hand-kept or stale seed data.

_HEALTH_HEADERS = {"User-Agent": "DF-AgencyHQ health check"}
_PORTAL_STATUS_KEYS = {"pendingApprovals": int, "contentDueThisWeek": int, "note": str, "updated": str}


def _check_site(url: str) -> tuple:
    """('ok'|'warn'|'down', note or None) for one URL."""
    import requests as _rq
    try:
        r = _rq.get(url, headers=_HEALTH_HEADERS, timeout=8, allow_redirects=True)
    except Exception as e:
        return "down", f"unreachable ({type(e).__name__})"
    if r.status_code < 400 or r.status_code in (401, 403):
        return "ok", None
    if r.status_code < 500:
        return "warn", f"HTTP {r.status_code}"
    return "down", f"HTTP {r.status_code}"


def _read_portal_status(portal_url: str) -> dict:
    """Fetch the portal's published agency-status.json, if it offers one.
    Unknown keys are dropped; a missing or malformed file is just {}."""
    import requests as _rq
    url = portal_url.rstrip("/") + "/agency-status.json"
    try:
        r = _rq.get(url, headers=_HEALTH_HEADERS, timeout=8)
        if r.status_code != 200:
            return {}
        data = r.json()
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, typ in _PORTAL_STATUS_KEYS.items():
        if key in data:
            try:
                out[key] = typ(data[key])
            except (ValueError, TypeError):
                pass
    return out


def _run_health_check(slug: str) -> dict:
    """Check one client's website + portal and store the fresh live block."""
    block = get_client_agency(slug)
    if not block:
        raise KeyError(slug)
    live: dict = {"checkedAt": datetime.utcnow().isoformat() + "Z"}
    website = (block.get("website") or "").strip()
    portal = (block.get("portalUrl") or "").strip()
    if website:
        health, note = _check_site(website)
        live["siteHealth"] = health
        if note:
            live["note"] = f"site: {note}"
    if portal:
        health, note = _check_site(portal)
        live["portalHealth"] = health
        if note:
            live["note"] = (live.get("note", "") + (" · " if live.get("note") else "") + f"portal: {note}")
        if health == "ok":
            live.update(_read_portal_status(portal))
    patch_client_agency(slug, {"live": live})
    return live


@app.post("/agency/api/clients/{slug}/health")
def agency_client_health(slug: str, request: Request):
    _agency_admin(request)
    try:
        live = _run_health_check(slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown client")
    return JSONResponse({"slug": slug, "live": live})


@app.post("/agency/api/health")
def agency_health_sweep(request: Request):
    """Check every client that has a website or portal URL, in parallel."""
    _agency_admin(request)
    from concurrent.futures import ThreadPoolExecutor
    from app.db import get_conn
    slugs = []
    with get_conn() as conn:
        for c in conn.execute("SELECT slug FROM clients").fetchall():
            block = get_client_agency(c["slug"])
            if (block.get("website") or "").strip() or (block.get("portalUrl") or "").strip():
                slugs.append(c["slug"])
    results = {}
    if slugs:
        with ThreadPoolExecutor(max_workers=min(8, len(slugs))) as pool:
            for slug, live in zip(slugs, pool.map(_run_health_check, slugs)):
                results[slug] = live
    checked = len(results)
    down = sum(1 for l in results.values()
               if l.get("siteHealth") == "down" or l.get("portalHealth") == "down")
    return JSONResponse({"checked": checked, "down": down, "results": results})


@app.post("/agency/api/assist/client-setup")
async def agency_assist_client_setup(request: Request):
    """Draft a whole client setup with Claude from a one-line description.
    Pure draft: nothing is saved until the operator reviews and creates."""
    _agency_admin(request)
    from app.assist import draft_client_setup
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A client name is required")
    result = draft_client_setup(
        name,
        (body.get("website") or "").strip(),
        (body.get("description") or "").strip(),
        body.get("kind") if body.get("kind") in ("client-hq", "reporting") else "reporting",
    )
    if not result.get("configured"):
        raise HTTPException(status_code=400, detail="Claude API is not configured (ANTHROPIC_API_KEY).")
    if not result.get("draft"):
        raise HTTPException(status_code=502, detail=(result.get("error") or "Draft failed")[:200])
    return JSONResponse({"draft": result["draft"]})


@app.patch("/agency/api/clients/{slug}")
async def agency_patch_client(slug: str, request: Request):
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    # A rename touches the display_name column, not the agency block.
    if body.get("name"):
        from app.db import get_conn
        with get_conn() as conn:
            conn.execute("UPDATE clients SET display_name = ? WHERE slug = ?", (body["name"].strip(), slug))
    patch = {k: v for k, v in body.items() if k in
             ("kind", "owner", "website", "cadence", "strategy", "live", "portalUrl", "portalStatus", "portalKind")}
    if patch:
        patch_client_agency(slug, patch)
    return JSONResponse(_agency_client_payload(slug))


@app.delete("/agency/api/clients/{slug}")
def agency_delete_client(slug: str, request: Request):
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    stored_paths = delete_client(slug)
    for p in stored_paths:
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass
    for folder in (settings.data_dir / slug, settings.reports_out_dir / slug):
        try:
            shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            pass
    return JSONResponse({"ok": True, "slug": slug})


@app.post("/agency/api/clients/{slug}/reporting")
async def agency_create_reporting(slug: str, request: Request):
    """Turn a client into a reporting client: flag the kind and ensure a report
    cadence, then hand the operator the reporting workspace where uploads,
    connections and the first build live. The client already exists as a DB row,
    so this is the honest, fully-real half of 'make everything work together'."""
    _agency_admin(request)
    block = get_client_agency(slug)
    if not block:
        raise HTTPException(status_code=404, detail="Unknown client")
    cadence = block.get("cadence") if isinstance(block.get("cadence"), dict) else {}
    if cadence.get("report", "none") == "none":
        cadence = {**cadence, "report": "monthly"}
    patch_client_agency(slug, {"kind": "reporting", "cadence": {**{"articlesPerWeek": 0, "reviewMonths": 6}, **cadence}})
    payload = _agency_client_payload(slug)
    payload["workspaceUrl"] = f"/admin/workspace?client={slug}"
    return JSONResponse(payload)


@app.post("/agency/api/clients/{slug}/portal")
async def agency_create_portal(slug: str, request: Request):
    """Track a BESPOKE Client HQ portal's lifecycle — a portal built and
    deployed to the client's own domain (the client-hq skill). This captures
    its state and URL; it doesn't build the site. For an instant working
    portal hosted on the app itself, use /hq instead."""
    _agency_admin(request)
    block = get_client_agency(slug)
    if not block:
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    status = body.get("status") if body.get("status") in ("none", "planned", "building", "live") else "planned"
    patch = {"kind": "client-hq", "portalStatus": status, "portalKind": "external"}
    if body.get("portalUrl") is not None:
        patch["portalUrl"] = (body["portalUrl"] or "").strip()
    if status == "none":
        patch["portalKind"] = None
    patch_client_agency(slug, patch)
    return JSONResponse(_agency_client_payload(slug))


@app.post("/agency/api/clients/{slug}/hq")
def agency_provision_hq(slug: str, request: Request):
    """Provision the BUILT-IN Client HQ portal for a client — the one this app
    already hosts at /portal (invite-gated, serves their reports and
    documents). One real click: flip the client to Client HQ, mark the portal
    live, and point it at the app's own portal. The operator then invites the
    client's people (portal members) from the same page. No separate deploy,
    no fake state — the portal works the moment a member accepts their invite."""
    _agency_admin(request)
    block = get_client_agency(slug)
    if not block:
        raise HTTPException(status_code=404, detail="Unknown client")
    patch_client_agency(slug, {
        "kind": "client-hq",
        "portalStatus": "live",
        "portalKind": "builtin",
        "portalUrl": f"{settings.app_url}/portal",
    })
    payload = _agency_client_payload(slug)
    payload["portalManageUrl"] = f"/admin/portal?client={slug}"
    return JSONResponse(payload)


# ---- unattended Client HQ build (Create HQ -> build the real site) --------
# The operator clicks once; the site + portal are built and deployed by an
# out-of-process runner (scripts/hq_builder.py) that executes the client-hq
# skill. This app owns the queue and the live build log; it never runs the
# build itself (a web request must not spawn an agentic deploy).

def _job_payload(job: dict | None) -> dict | None:
    """The public shape of a build job for the Agency HQ UI (admin-only)."""
    if not job:
        return None
    return {
        "id": job["id"],
        "slug": job["client_slug"],
        "status": job["status"],
        "log": job.get("log") or "",
        "portalUrl": job.get("portal_url"),
        "error": job.get("error"),
        "buildPack": job.get("build_pack") or {},
        "createdAt": job.get("created_at"),
        "startedAt": job.get("started_at"),
        "finishedAt": job.get("finished_at"),
    }


def _fallback_build_pack(slug: str, name: str, block: dict) -> dict:
    """A deterministic, intake-shaped build spec used when Claude isn't
    configured, so the build pipeline still works end-to-end (the runner's
    dry-run proves it). Mirrors app.assist.draft_hq_build_pack's shape."""
    from app.assist import OPERATOR_REQUIRED
    website = (block.get("website") or "").strip()
    domain = website.replace("https://", "").replace("http://", "").strip("/").split("/")[0]
    return {
        "name": name,
        "slug": slug,
        "owner": block.get("owner") or "Unassigned",
        "client": {"wordmark": name, "domain": domain, "brief": "", "timezone_guess": "Europe/London"},
        "site": {"exists": bool(domain), "kind": "php-static", "register_driven_content": True,
                 "pages": ["Home", "About", "Services", "Contact"], "primary_cta": "Get in touch",
                 "same_account": True},
        "rooms": {"content_engine": "yes", "social_builder": "yes", "buffer": "later",
                  "month_planner": "yes", "plan_approvals": "yes", "site_health": "yes", "reports": "later"},
        "brand": {"primary_color": "#1f2937", "accent_color": "#2563eb", "tone_adjectives": [],
                  "person": "we", "english_variant": "British English", "hard_rules": "", "tagline": ""},
        "audience": "", "no_gos": [], "channels": ["Instagram", "Facebook"],
        "cadence": {"articles_per_month": 4, "posts_per_week": 3, "reels_per_month": 0},
        "posting_time": "17:00", "content_strands": [],
        "reporting": {"on_platform": True, "headline_numbers": []},
        "hosting": {"repo_name": slug, "owner": "plot31agate", "domain": domain,
                    "notes": "drafted without Claude (no API key)"},
        "operator_required": OPERATOR_REQUIRED,
    }


@app.post("/agency/api/clients/{slug}/build-hq")
async def agency_build_hq(slug: str, request: Request):
    """Queue an unattended Client HQ build. Drafts the build spec with Claude,
    enqueues a job for the runner, and flips the client to 'building'. The
    button that calls this then polls GET /build-hq to stream the build log."""
    user = _agency_admin(request)
    block = get_client_agency(slug)
    if not block:
        raise HTTPException(status_code=404, detail="Unknown client")

    # Don't stack builds: if one is already in flight, hand it back.
    existing = get_latest_hq_build_job(slug)
    if existing and existing["status"] in ("queued", "running"):
        return JSONResponse({"job": _job_payload(existing), "client": _agency_client_payload(slug),
                             "reused": True})

    row = get_client_row(slug)
    name = row["display_name"] if row else slug
    from app.assist import draft_hq_build_pack
    result = draft_hq_build_pack(name, (block.get("website") or "").strip(),
                                 "", block.get("owner") or "Unassigned")
    if result.get("configured") and result.get("pack"):
        pack = result["pack"]
    elif result.get("configured") and result.get("error"):
        # Claude configured but the draft failed — don't silently ship a stub.
        raise HTTPException(status_code=502, detail=("Build-spec draft failed: "
                                                     + (result.get("error") or ""))[:200])
    else:
        # No API key: fall back to a deterministic spec so the build still runs.
        pack = _fallback_build_pack(slug, name, block)

    job_id = create_hq_build_job(slug, pack, created_by=user if isinstance(user, str) else None)
    patch_client_agency(slug, {"kind": "client-hq", "portalStatus": "building", "portalKind": "external"})
    return JSONResponse({"job": _job_payload(get_hq_build_job(job_id)),
                         "client": _agency_client_payload(slug), "reused": False})


@app.get("/agency/api/clients/{slug}/build-hq")
def agency_build_hq_status(slug: str, request: Request):
    """Latest build job for a client — the UI polls this for the live log and
    the building -> live transition."""
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    return JSONResponse({"job": _job_payload(get_latest_hq_build_job(slug))})


@app.post("/agency/api/build-jobs/{job_id}/cancel")
def agency_cancel_build(job_id: int, request: Request):
    """Cancel a queued or running build. The runner checks for this and stops."""
    _agency_admin(request)
    ok = cancel_hq_build_job(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail="Job already finished")
    return JSONResponse({"ok": True})


@app.post("/agency/api/clients/{slug}/portal-users")
async def agency_add_portal_user(slug: str, request: Request):
    """Invite a person to the client's built-in portal. Returns the join link
    (one-click magic link, no password) for the operator to send on."""
    _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    token = secrets.token_urlsafe(24)
    try:
        create_client_user(slug, email, (body.get("name") or "").strip(), token)
    except Exception:
        raise HTTPException(status_code=409, detail="That email already has access")
    return JSONResponse({"ok": True, "invite_url": f"{settings.app_url}/portal/join/{token}"})


@app.post("/agency/api/portal-users/{user_id}/revoke")
def agency_revoke_portal_user(user_id: int, request: Request):
    _agency_admin(request)
    user = get_client_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Unknown portal user")
    revoke_client_user(user_id)
    return JSONResponse({"ok": True})


# ---- credential vault ----

@app.post("/agency/api/clients/{slug}/secrets")
async def agency_create_secret(slug: str, request: Request):
    user = _agency_admin(request)
    if not get_client_row(slug):
        raise HTTPException(status_code=404, detail="Unknown client")
    body = await request.json()
    label = (body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="A label is required (e.g. 'WordPress admin')")
    password = body.get("password") or ""
    try:
        cipher = vault.encrypt(password) if password else None
    except vault.VaultError as e:
        raise HTTPException(status_code=409, detail=str(e))
    sid = create_client_secret(
        slug, label, (body.get("login_url") or "").strip() or None,
        (body.get("username") or "").strip() or None, cipher,
        (body.get("notes") or "").strip() or None, user,
    )
    return JSONResponse({"ok": True, "id": sid})


@app.patch("/agency/api/secrets/{secret_id}")
async def agency_update_secret(secret_id: int, request: Request):
    user = _agency_admin(request)
    existing = get_client_secret(secret_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Unknown secret")
    body = await request.json()
    label = (body.get("label") or existing["label"]).strip()
    # password: key absent → keep; empty string → clear; value → re-encrypt.
    cipher = None
    if "password" in body:
        pw = body.get("password") or ""
        try:
            cipher = vault.encrypt(pw) if pw else ""
        except vault.VaultError as e:
            raise HTTPException(status_code=409, detail=str(e))
    update_client_secret(
        secret_id, label, (body.get("login_url") or "").strip() or None,
        (body.get("username") or "").strip() or None, cipher,
        (body.get("notes") or "").strip() or None, user,
    )
    return JSONResponse({"ok": True})


@app.post("/agency/api/secrets/{secret_id}/reveal")
def agency_reveal_secret(secret_id: int, request: Request):
    user = _agency_admin(request)
    row = get_client_secret(secret_id)
    if not row:
        raise HTTPException(status_code=404, detail="Unknown secret")
    if not row["secret_cipher"]:
        return JSONResponse({"password": ""})
    try:
        plain = vault.decrypt(row["secret_cipher"])
    except vault.VaultError as e:
        raise HTTPException(status_code=409, detail=str(e))
    touch_secret_reveal(secret_id, user)
    return JSONResponse({"password": plain})


@app.delete("/agency/api/secrets/{secret_id}")
def agency_delete_secret(secret_id: int, request: Request):
    _agency_admin(request)
    if not get_client_secret(secret_id):
        raise HTTPException(status_code=404, detail="Unknown secret")
    delete_client_secret(secret_id)
    return JSONResponse({"ok": True})


@app.get("/agency")
def agency_root():
    # Normalise to the trailing slash so the SPA's absolute /agency/ asset URLs
    # resolve (StaticFiles serves the shell at /agency/).
    return RedirectResponse("/agency/")


if AGENCY_DIST.is_dir():
    app.mount("/agency", StaticFiles(directory=str(AGENCY_DIST), html=True), name="agency")

env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)
env.filters["thousands"] = lambda v: f"{v:,}" if isinstance(v, (int, float)) else v


def _month_name(period: str) -> str:
    """'2026-06' -> 'June 2026'."""
    try:
        return datetime.strptime(period, "%Y-%m").strftime("%B %Y")
    except (ValueError, TypeError):
        return period or ""


def _stamp(iso: str) -> str:
    """ISO timestamp -> '9 Jul 2026, 14:43'. Blank stays blank."""
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso).strftime("%-d %b %Y, %H:%M")
    except (ValueError, TypeError):
        return str(iso)[:16].replace("T", " ")


env.filters["monthname"] = _month_name
env.filters["stamp"] = _stamp

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


@app.post("/admin/clients/delete")
def admin_delete_client(request: Request, client_slug: str = Form(...)):
    _require_admin_or_redirect(request)
    row = get_client_row(client_slug)
    if not row:
        return RedirectResponse("/admin?error=Client+not+found", status_code=302)

    display_name = row["display_name"]
    # Drop every DB row for this client; get back the on-disk files to remove.
    stored_paths = delete_client(client_slug)

    for p in stored_paths:
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass
    # Wipe the client's uploaded-data and generated-report folders too.
    for folder in (settings.data_dir / client_slug, settings.reports_out_dir / client_slug):
        try:
            shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            pass

    from urllib.parse import quote_plus
    return RedirectResponse(
        f"/admin?message={quote_plus(display_name + ' deleted')}", status_code=302
    )


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
    # settings; search_console prefers direct Google over Ahrefs GSC Insights.
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
                # A provider can be pickable on the agency key alone (Serper
                # mentions needs no per-client field), so there may be no
                # client connection row - don't assume conns[provider] exists.
                "status": (conns.get(provider) or {}).get("status"),
            }
    # Only show source cards for the sections this client's report includes,
    # grouped by relation for the accordion layout.
    client_sources = enabled_source_keys(client_config)
    client_source_defs = [s for s in SOURCE_DEFS if s["key"] in client_sources]
    defs_by_key = {s["key"]: s for s in client_source_defs}
    source_groups = []
    for g in SOURCE_GROUPS:
        defs = [defs_by_key[k] for k in g["sources"] if k in defs_by_key]
        if defs:
            source_groups.append({"key": g["key"], "label": g["label"], "defs": defs})

    # Setup-status strip: what's configured for this client, with links into
    # the settings page — so a fresh month makes the missing setup obvious.
    _raw_row = get_client_row(slug) or {}
    try:
        _raw_cfg = json.loads(_raw_row.get("config_json") or "{}")
    except (ValueError, TypeError):
        _raw_cfg = {}
    feeds = client_config.get("mention_feeds") or []
    live_providers = sorted({v["provider"] for v in connected_sources.values()})
    setup_items = [
        {"anchor": "connections", "label": "API connections",
         "ok": bool(live_providers),
         "sub": f"{len(live_providers)} live" if live_providers else "set up →"},
        {"anchor": "mention-feeds", "label": "Mention feeds",
         "ok": bool(feeds),
         "sub": f"{len(feeds)} feed{'s' if len(feeds) != 1 else ''}" if feeds else "add →"},
        {"anchor": "sentiment-brief", "label": "Sentiment brief",
         "ok": bool((_raw_cfg.get("sentiment_context") or "").strip()),
         "sub": "custom" if (_raw_cfg.get("sentiment_context") or "").strip() else "generic →"},
        {"anchor": "report-focus", "label": "Report focus",
         "ok": bool((_raw_cfg.get("report_focus") or "").strip()),
         "sub": "set" if (_raw_cfg.get("report_focus") or "").strip() else "optional"},
        {"anchor": "report-sections", "label": "Sections",
         "ok": True,
         "sub": f"{len(enabled_sections(client_config))} of {len(SECTION_DEFS)}"},
    ]

    # What already exists for this client, and whether the month on screen has
    # data newer than its last build - shown in the rail so a regenerate is
    # never a guess about which month is being overwritten.
    months = report_index(slug)
    this_month = next((m for m in months if m["period"] == period), None)
    # The builder reads the data folder, so a month with files on disk can be
    # generated even when no upload row exists for it (seeded or FTP'd data).
    has_data = bool(list_uploads(slug, period)) or bool(this_month and this_month["source_count"])

    return _render(
        "admin/workspace.html",
        active="workspace",
        nav_clients=clients,
        active_client=slug,
        client=client_config,
        selected_client=slug,
        period=period,
        months=months,
        this_month=this_month,
        source_defs=client_source_defs,
        source_groups=source_groups,
        setup_items=setup_items,
        report=report,
        has_uploads=has_data,
        shares=shares,
        views=views,
        portal_member_count=len(portal_members),
        connected_sources=connected_sources,
        message=message,
        error=error,
        share_url=share_url,
    )


@app.get("/admin/client-settings", response_class=HTMLResponse)
def admin_client_settings(request: Request, client: str = None, message: str = None, error: str = None):
    """Configure-once-per-client settings: API connections, mention feeds,
    sentiment brief, report focus and report sections. Split out of the
    workspace so the monthly screen stays purely data in / build / deliver."""
    _require_admin_or_redirect(request)
    clients = list_clients()
    if not clients:
        return RedirectResponse("/admin/clients/new", status_code=302)
    slug = client if client and any(c["slug"] == client for c in clients) else clients[0]["slug"]

    client_config = get_client(slug)
    # Are the briefs per-client customs, or the generic fallbacks?
    _raw_row = get_client_row(slug) or {}
    try:
        _raw_cfg = json.loads(_raw_row.get("config_json") or "{}")
    except (ValueError, TypeError):
        _raw_cfg = {}
    sentiment_is_custom = bool((_raw_cfg.get("sentiment_context") or "").strip())
    focus_is_custom = bool((_raw_cfg.get("report_focus") or "").strip())

    conns = get_connections(slug)
    agency_creds = get_agency_credentials()
    client_sources = enabled_source_keys(client_config)
    # A connector's card shows when it feeds an enabled source, or is already
    # set up (so an existing connection is never hidden by a section toggle).
    connection_cards = [
        _masked_connection_view(conns.get(d["provider"]), d, agency_creds.get(d["provider"]))
        for d in connectors.CONNECTOR_DEFS
        if (set(d["sources"]) & client_sources) or conns.get(d["provider"])
    ]

    return _render(
        "admin/client_settings.html",
        active="client_settings",
        nav_clients=clients,
        active_client=slug,
        clients=clients,
        client=client_config,
        selected_client=slug,
        sentiment_is_custom=sentiment_is_custom,
        focus_is_custom=focus_is_custom,
        section_defs=SECTION_DEFS,
        client_sections=enabled_sections(client_config),
        connection_cards=connection_cards,
        message=message,
        error=error,
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

    # LinkedIn's native export is three separate files (content, followers,
    # visitors) that all belong to this one card - suffix each by kind so
    # they coexist instead of overwriting, and let the parser merge them.
    if source_key == "linkedin_company" and ext in (".xls", ".xlsx"):
        from app.ingestion.parsers.linkedin import detect_export_kind
        kind = detect_export_kind(dest, file.filename)
        if kind:
            kind_dest = dest_dir / f"{source_key}_{period}_{kind}{ext}"
            if kind_dest != dest:
                kind_dest.unlink(missing_ok=True)
                dest.rename(kind_dest)
                dest = kind_dest
            for old_ext in (".xls", ".xlsx", ".csv"):
                (dest_dir / f"{source_key}_{period}{old_ext}").unlink(missing_ok=True)

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
    expected_dir = settings.data_dir / client_slug / period
    for p in paths:
        f = Path(p)
        # Only ever delete files inside this client+period's data folder.
        if f.exists() and f.parent == expected_dir:
            f.unlink()
            removed += 1
    # Kind-suffixed uploads (e.g. the three LinkedIn exports) record only the
    # last file on their upload row - sweep every file a parser would pick up,
    # or a reset period keeps feeding old data into builds.
    if expected_dir.exists():
        for key in PARSER_MAP:
            for f in expected_dir.glob(f"{key}_*"):
                if f.is_file():
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
    return {"lean_into": [], "investigate": [], "fix_urgently": None, "worked": [], "watch": []}


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
    worked = (actions.get("worked") or []) + [""] * 5
    watch = (actions.get("watch") or []) + [""] * 5

    html_path = settings.reports_out_dir / client / f"{period}.html"
    preview_url = f"/c/{client}/{period}" if html_path.exists() else None

    context.update({
        "editable": True,
        "edit_lean": lean[:3],
        "edit_invest": invest[:3],
        "edit_fix": fix,
        "edit_worked": worked[:5],
        "edit_watch": watch[:5],
        "preview_url": preview_url,
        "message": message,
    })

    html = _env().get_template("report.html").render(**context)
    return HTMLResponse(html)


@app.post("/admin/review/regenerate")
async def admin_review_regenerate(request: Request):
    """Discard this period's written commentary and rewrite it from the current
    data and the current briefs.

    The automatic refresh can only rewrite text it knows the AI authored. On a
    report built before ai_seed_json was recorded there is no such record, so
    every field reads as a hand-edit and survives forever - which is how a
    report keeps leading on media after the focus brief says otherwise. This is
    the operator's way out, and it is deliberately explicit: it throws away any
    real edits on the period too, so it is never something a build does by itself.
    """
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    period = form.get("period")
    if not client_slug or not period:
        return RedirectResponse("/admin?error=Regenerate+was+missing+client+or+period", status_code=302)

    back = f"/admin/review?client={client_slug}&period={period}"
    clear_commentary_text(client_slug, period)
    try:
        build_report(client_slug, period)
    except Exception as e:
        return RedirectResponse(f"{back}&message=Commentary+cleared+but+build+failed:+{str(e)[:120]}", status_code=302)
    return RedirectResponse(f"{back}&message=Commentary+rewritten+from+the+current+data+and+briefs", status_code=302)


@app.post("/admin/review/reset-layout")
async def admin_review_reset_layout(request: Request):
    """Undo structure. `scope=month` drops this month's own layout edits so it
    follows the client layout again; `scope=client` clears the saved layout so
    later months start from the data with nothing carried forward."""
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    period = form.get("period")
    scope = form.get("scope")
    if not client_slug or not period:
        return RedirectResponse("/admin?error=Reset+was+missing+client+or+period", status_code=302)
    back = f"/admin/review?client={client_slug}&period={period}"

    if scope == "client":
        save_report_layout(client_slug, {})
        msg = "Saved+layout+cleared+-+later+months+start+from+the+data"
    else:
        row = get_commentary(client_slug, period)
        try:
            notes = json.loads((row or {}).get("notes_json") or "{}")
        except (ValueError, TypeError):
            notes = {}
        for key in list(LAYOUT_KEYS) + ["_edited"]:
            notes.pop(key, None)
        upsert_commentary(client_slug, period, (row or {}).get("headline") or "Performance Report",
                          (row or {}).get("standfirst") or "", json.dumps(notes),
                          (row or {}).get("actions_json"))
        # If this month is the one that set the standing layout, resetting it
        # has to clear that too - otherwise the month falls straight back onto
        # a layout encoding the very edits just undone, and nothing changes.
        if (get_report_layout(client_slug) or {}).get("from_period") == period:
            save_report_layout(client_slug, {})
            msg = "This+month+reset+-+the+layout+it+set+is+cleared+too"
        else:
            msg = "This+month+reset+-+it+follows+the+saved+layout+again"

    try:
        build_report(client_slug, period)
    except Exception as e:
        return RedirectResponse(f"{back}&message=Reset+but+build+failed:+{str(e)[:100]}", status_code=302)
    return RedirectResponse(f"{back}&message={msg}", status_code=302)


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
        caveat = (form.get(f"callout_{key}") or "").strip()
        if caveat:
            notes[f"callout_{key}"] = caveat

    # Stat-box overrides: every rendered box submits its edited value/label,
    # keep tick, position, and the computed defaults. Only deviations from
    # the defaults are stored, so an untouched box keeps tracking the data.
    stat_overrides = {}
    for field in form.keys():
        if not (field.startswith("stat_") and field.endswith("__dvalue")):
            continue
        sid = field[len("stat_"):-len("__dvalue")]
        value = (form.get(f"stat_{sid}__value") or "").strip()
        label = (form.get(f"stat_{sid}__label") or "").strip()
        ov = {}
        if value and value != (form.get(field) or "").strip():
            ov["value"] = value
        if label and label != (form.get(f"stat_{sid}__dlabel") or "").strip():
            ov["label"] = label
        if form.get(f"stat_{sid}__show") != "1":
            ov["hide"] = True
        try:
            order = int(form.get(f"stat_{sid}__order"))
            if order != int(form.get(f"stat_{sid}__dorder")):
                ov["order"] = order
        except (TypeError, ValueError):
            pass
        if ov:
            stat_overrides[sid] = ov
    if stat_overrides:
        notes["stats"] = stat_overrides

    # At-a-glance overrides: status flips and rewritten headline/next lines,
    # stored only where they deviate from the computed defaults (the same
    # pattern as stat boxes). Row drops ride the generic keep_/rowkey_
    # machinery, and area/owner renames the generic cell machinery — so the
    # overrides here are month-specific by design and never carry forward.
    glance_overrides = {}
    for field in form.keys():
        if not (field.startswith("glance_") and field.endswith("__dstatus")):
            continue
        gkey = field[len("glance_"):-len("__dstatus")]
        ov = {}
        status = (form.get(f"glance_{gkey}__status") or "").strip()
        if status and status != (form.get(field) or "").strip():
            ov["status"] = status
        headline = (form.get(f"glance_{gkey}__headline") or "").strip()
        if headline and headline != (form.get(f"glance_{gkey}__dheadline") or "").strip():
            ov["headline"] = headline
        nxt = (form.get(f"glance_{gkey}__next") or "").strip()
        if nxt and nxt != (form.get(f"glance_{gkey}__dnext") or "").strip():
            ov["next"] = nxt
        if ov:
            glance_overrides[gkey] = ov
    if glance_overrides:
        notes["glance"] = glance_overrides

    # Dropped rows: every rendered row submits a rowkey_ marker, and a ticked
    # keep_ alongside it. A marker with no keep means the operator unticked it.
    dropped = [
        field[len("rowkey_"):]
        for field in form.keys()
        if field.startswith("rowkey_") and form.get("keep_" + field[len("rowkey_"):]) != "1"
    ]
    if dropped:
        notes["hidden"] = sorted(set(dropped))

    # Whole sections switched off for this month, same marker pattern.
    hidden_sections = [
        field[len("sectionkey_"):]
        for field in form.keys()
        if field.startswith("sectionkey_")
        and form.get("section_" + field[len("sectionkey_"):] + "__show") != "1"
    ]
    if hidden_sections:
        notes["hidden_sections"] = sorted(set(hidden_sections))

    # Rewritten cell text. Each editable cell submits its current value beside
    # the computed default; only a real change is stored, so an untouched cell
    # keeps following the data.
    cells = {}
    for field in form.keys():
        if not (field.startswith("cell_") and field.endswith("__d")):
            continue
        ckey = field[len("cell_"):-len("__d")]
        value = (form.get(f"cell_{ckey}__v") or "").strip()
        if value and value != (form.get(field) or "").strip():
            cells[ckey] = value
    if cells:
        notes["cells"] = cells

    # This month now owns its structure outright: an absent section means
    # shown, not "inherit the layout".
    notes["_edited"] = True

    def _bucket(prefix):
        items = []
        for i in range(3):
            action = (form.get(f"{prefix}_{i}_action") or "").strip()
            why = (form.get(f"{prefix}_{i}_why") or "").strip()
            if action:
                items.append({"action": action, "why": why})
        return items

    def _lines(prefix, count=5):
        items = []
        for i in range(count):
            val = (form.get(f"{prefix}_{i}") or "").strip()
            if val:
                items.append(val)
        return items

    fix_action = (form.get("fix_0_action") or "").strip()
    fix_why = (form.get("fix_0_why") or "").strip()
    actions = {
        "lean_into": _bucket("lean_into"),
        "investigate": _bucket("investigate"),
        "fix_urgently": {"action": fix_action, "why": fix_why} if fix_action else None,
        "worked": _lines("worked"),
        "watch": _lines("watch"),
    }

    upsert_commentary(
        client_slug, period, headline, standfirst,
        json.dumps(notes), json.dumps(actions),
    )

    # Structural choices become the client's standing layout, so the next
    # month starts where this one left off. Stat box values are stripped on
    # the way in - that number belongs to this month only.
    layout = layout_from_notes(notes)
    if layout:
        layout["from_period"] = period
        save_report_layout(client_slug, layout)
    else:
        save_report_layout(client_slug, {})

    # Per-story mention overrides: a sentiment <select> is rendered for every
    # story (so its key is always in the form); an unticked "keep" checkbox
    # simply doesn't submit, which means excluded.
    mention_overrides = {}
    for field in form.keys():
        if field.startswith("mx_") and field.endswith("_sentiment"):
            key = field[3:-len("_sentiment")]
            kept = form.get(f"mx_{key}_keep") == "1"
            sentiment = (form.get(field) or "").strip() or None
            if sentiment not in ("positive", "neutral", "negative"):
                sentiment = None
            mention_overrides[key] = {"excluded": not kept, "sentiment": sentiment}
    set_mention_overrides(client_slug, period, mention_overrides)

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
    merged = {**agency, **client}
    # Client identity, for connectors that build queries from it (e.g. Serper
    # mentions falls back to the brand name + tracked executives). Underscored
    # so they never collide with a real connection field.
    try:
        cc = get_client(client_slug)
        merged["_display_name"] = cc.get("display_name")
        merged["_executives"] = cc.get("executives") or []
    except KeyError:
        pass
    return merged


def _masked_connection_view(conn_row, cdef, agency_row) -> dict:
    """Per-client connection state for the workspace panel."""
    saved = _parse_config(conn_row)
    # Secret client fields (e.g. a per-client Meta token) are never echoed back;
    # the form shows a masked placeholder and blank-means-keep, like agency keys.
    fields = []
    for f in cdef["client_fields"]:
        val = (saved.get(f["key"]) or "").strip()
        if f.get("secret"):
            fields.append({**f, "value": "", "has_value": bool(val)})
        else:
            fields.append({**f, "value": val, "has_value": bool(val)})
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

@app.get("/admin/how-it-works", response_class=HTMLResponse)
def admin_how_it_works(request: Request):
    _require_admin_or_redirect(request)
    return _render("admin/how_it_works.html", active="how_it_works", nav_clients=list_clients())


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
    """Connections live on the client settings page now."""
    _require_admin_or_redirect(request)
    suffix = f"?client={client}" if client else ""
    return RedirectResponse(f"/admin/client-settings{suffix}#connections", status_code=302)


def _connections_redirect(client_slug: str, period: str = None, message: str = None, error: str = None):
    url = f"/admin/client-settings?client={client_slug}"
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

    old = _parse_config(get_connection(client_slug, provider))
    config = {}
    for f in cdef["client_fields"]:
        val = (form.get(f["key"]) or "").strip()
        # Secrets are write-only: blank means keep what's already saved.
        if not val and f.get("secret"):
            val = old.get(f["key"], "")
        config[f["key"]] = val
    upsert_connection(client_slug, provider, json.dumps(config))
    return _connections_redirect(client_slug, form.get("period"),
                                 message=f"{cdef['label']}+settings+saved")


@app.post("/admin/connections/test")
def admin_connections_test(request: Request, client_slug: str = Form(...), provider: str = Form(...), period: str = Form(None)):
    _require_admin_or_redirect(request)
    row = get_connection(client_slug, provider)
    if not row:
        return _connections_redirect(client_slug, period, error="Save+the+settings+first")
    # A client on a separate portfolio can carry its own secret token, so the
    # agency key is only required when the client hasn't supplied one.
    cdef = connectors.get_def(provider)
    saved = _parse_config(row)
    client_has_secret = any(
        f.get("secret") and (saved.get(f["key"]) or "").strip() for f in cdef["client_fields"]
    )
    if not get_agency_credential(provider) and not client_has_secret:
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
    providers = connectors.pick_providers(source_key, agency_creds, client_cfgs)
    if not providers:
        if not any(p in agency_creds for p in candidates):
            msg = "No agency key for this source - add one on the API keys page"
        else:
            needed = ", ".join(
                (" or ".join(k) if isinstance(k, tuple) else k)
                for p in candidates if p in agency_creds
                for k in connectors.get_def(p).get("requires", {}).get(source_key, [])
            )
            msg = f"Missing client settings ({needed}) - fill them in under API connections below"
        return JSONResponse({"status": "error", "summary": msg, "warnings": [], "row_count": 0})

    client_cfg = get_client(client_slug)
    dest_dir = settings.data_dir / client_slug / period
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{source_key}_{period}.csv"

    # Try each configured route in preference order. A source with a second
    # route (search_console: Google direct, then Ahrefs GSC Insights) stays
    # up when the preferred one errors - a 403 on a property the service
    # account was never granted shouldn't take search data offline.
    config = None
    provider = None
    fallback_notes = []
    errors = []
    for candidate in providers:
        cfg = _merged_config(candidate, client_slug)
        # Brand context for connectors that report on the client by name.
        cfg["competitor_names"] = client_cfg.get("competitors") or []
        cfg["client_display_name"] = client_cfg.get("display_name") or client_slug
        label = connectors.get_def(candidate)["label"]
        try:
            connectors.sync_source(candidate, cfg, source_key, dest, period)
        except ConnectorError as e:
            errors.append(f"{label}: {str(e)[:180]}")
            set_connection_status(client_slug, candidate, "error", str(e)[:200])
            continue
        except Exception as e:
            errors.append(f"{label}: sync failed - {str(e)[:150]}")
            continue
        provider, config = candidate, cfg
        # A silent downgrade reads as success on the card, so say what failed.
        fallback_notes = [f"{msg} - fell back to {label}" for msg in errors]
        break

    if provider is None:
        summary = " | ".join(errors) if errors else "Sync failed"
        err = {"status": "error", "summary": summary[:400], "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key,
                      f"API sync · {connectors.get_def(providers[0])['label']}",
                      str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)

    filename = f"API sync · {connectors.get_def(provider)['label']}"

    try:
        label, parser = PARSER_MAP[source_key]
        data = parser(dest)
        result = summarise_parsed(source_key, data)
        # Connectors can flag a partial pull (e.g. Meta got Instagram but no
        # Facebook rows) by attaching warnings to the config it was handed.
        extra = (config.get("_warnings") or []) + fallback_notes
        if extra:
            result["warnings"] = (result.get("warnings") or []) + extra
        upsert_upload(client_slug, period, source_key, filename, str(dest),
                      result["status"], result.get("row_count", 0), json.dumps(result))
        set_connection_status(client_slug, provider, "ok", "Last sync OK", synced=True)
        return JSONResponse(result)
    except Exception as e:
        err = {"status": "error", "summary": f"Synced but could not parse ({str(e)[:120]})", "warnings": [], "row_count": 0}
        upsert_upload(client_slug, period, source_key, filename, str(dest), "error", 0, json.dumps(err))
        return JSONResponse(err)


# ------------------- ADMIN FETCH MENTIONS -------------------

@app.post("/admin/mention-feeds/save")
async def admin_mention_feeds_save(request: Request):
    """Save the client's RSS/Atom mention feed list (one URL per line)."""
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    back = f"/admin/client-settings?client={client_slug}"

    urls = [line.strip() for line in (form.get("feeds") or "").splitlines() if line.strip()]
    bad = [u for u in urls if not u.startswith(("http://", "https://"))]
    if bad:
        return RedirectResponse(f"{back}&error=Feed+URLs+must+start+with+http(s)://+-+check:+{bad[0][:60]}", status_code=302)
    try:
        update_client_config_key(client_slug, "mention_feeds", urls)
    except KeyError:
        return RedirectResponse(f"{back}&error=Unknown+client", status_code=302)
    return RedirectResponse(f"{back}&message=Saved+{len(urls)}+mention+feed{'s' if len(urls) != 1 else ''}", status_code=302)


@app.post("/admin/sentiment-brief/draft")
async def admin_sentiment_brief_draft(request: Request):
    """Draft a sentiment brief with Claude from a one-line description.
    Returns JSON {brief} so the workspace can fill the textarea in place."""
    _require_admin_or_redirect(request)
    from app.sentiment import draft_sentiment_brief
    form = await request.form()
    client_slug = form.get("client_slug")
    description = (form.get("description") or "").strip()
    try:
        cfg = get_client(client_slug)
    except KeyError:
        return JSONResponse({"error": "Unknown client"}, status_code=400)

    result = draft_sentiment_brief(cfg.get("display_name") or client_slug, description, cfg.get("competitors"))
    if not result.get("configured"):
        return JSONResponse({"error": "Claude API is not configured (ANTHROPIC_API_KEY)."}, status_code=400)
    if not result.get("brief"):
        return JSONResponse({"error": (result.get("error") or "Draft failed")[:200]}, status_code=502)
    return JSONResponse({"brief": result["brief"]})


@app.post("/admin/sentiment-brief/save")
async def admin_sentiment_brief_save(request: Request):
    """Save the client's sentiment brief and tracked executive list. The brief
    is the context Claude scores every mention against; executives are the
    names scanned for in coverage."""
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    back = f"/admin/client-settings?client={client_slug}"

    brief = (form.get("sentiment_context") or "").strip()
    execs = [line.strip() for line in (form.get("executives") or "").splitlines() if line.strip()]
    try:
        update_client_config_key(client_slug, "sentiment_context", brief)
        update_client_config_key(client_slug, "executives", execs)
    except KeyError:
        return RedirectResponse(f"{back}&error=Unknown+client", status_code=302)
    return RedirectResponse(f"{back}&message=Saved+sentiment+brief+and+{len(execs)}+executive{'s' if len(execs) != 1 else ''}", status_code=302)


@app.post("/admin/report-focus/draft")
async def admin_report_focus_draft(request: Request):
    """Draft a report-focus brief with Claude from a one-line description.
    Returns JSON {brief} so the workspace can fill the textarea in place."""
    _require_admin_or_redirect(request)
    from app.sentiment import draft_report_focus
    form = await request.form()
    client_slug = form.get("client_slug")
    description = (form.get("description") or "").strip()
    try:
        cfg = get_client(client_slug)
    except KeyError:
        return JSONResponse({"error": "Unknown client"}, status_code=400)

    labels = {d["key"]: d["label"] for d in SECTION_DEFS}
    section_labels = [labels[k] for k in enabled_sections(cfg) if k in labels]
    result = draft_report_focus(cfg.get("display_name") or client_slug, description, section_labels)
    if not result.get("configured"):
        return JSONResponse({"error": "Claude API is not configured (ANTHROPIC_API_KEY)."}, status_code=400)
    if not result.get("brief"):
        return JSONResponse({"error": (result.get("error") or "Draft failed")[:200]}, status_code=502)
    return JSONResponse({"brief": result["brief"]})


@app.post("/admin/report-focus/save")
async def admin_report_focus_save(request: Request):
    """Save the client's report-focus brief - the editorial steer that decides
    which areas lead the report's commentary."""
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    back = f"/admin/client-settings?client={client_slug}"

    brief = (form.get("report_focus") or "").strip()
    try:
        update_client_config_key(client_slug, "report_focus", brief)
    except KeyError:
        return RedirectResponse(f"{back}&error=Unknown+client", status_code=302)
    msg = "Saved+report+focus" if brief else "Cleared+report+focus+-+commentary+follows+the+enabled+sections"
    return RedirectResponse(f"{back}&message={msg}", status_code=302)


@app.post("/admin/sections/save")
async def admin_sections_save(request: Request):
    """Save which report sections this client's reports include."""
    _require_admin_or_redirect(request)
    form = await request.form()
    client_slug = form.get("client_slug")
    back = f"/admin/client-settings?client={client_slug}"

    chosen = [k for k in form.getlist("sections") if k in ALL_SECTION_KEYS]
    if not chosen:
        return RedirectResponse(f"{back}&error=Pick+at+least+one+section", status_code=302)
    try:
        update_client_config_key(client_slug, "sections", chosen)
        update_client_config_key(client_slug, "misc_title", (form.get("misc_title") or "").strip())
    except KeyError:
        return RedirectResponse(f"{back}&error=Unknown+client", status_code=302)
    return RedirectResponse(f"{back}&message=Report+sections+saved+({len(chosen)}+enabled)", status_code=302)


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

    documents = [
        {**d, "updated_display": d["updated"].strftime("%b %Y")}
        for d in list_client_documents(slug)
    ]

    return _render("portal/home.html", client=client, user=user,
                   reports=reports, documents=documents)


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


_DOC_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _doc_title(html: str, fallback: str) -> str:
    """Pull the <title> out of a document, falling back to a prettified filename."""
    m = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if m and m.group(1).strip():
        return re.sub(r"\s+", " ", m.group(1)).strip()
    return fallback.replace("-", " ").replace("_", " ").title()


def list_client_documents(slug: str) -> list:
    """Curated documents for a client, newest first. Scans client_docs/<slug>/*.html."""
    doc_dir = settings.client_docs_dir / slug
    if not doc_dir.is_dir():
        return []
    docs = []
    for path in doc_dir.glob("*.html"):
        try:
            html = path.read_text(encoding="utf-8")
        except OSError:
            continue
        docs.append({
            "name": path.stem,
            "title": _doc_title(html, path.stem),
            "updated": datetime.fromtimestamp(path.stat().st_mtime),
        })
    docs.sort(key=lambda d: d["updated"], reverse=True)
    return docs


def _resolve_document(slug: str, name: str) -> Path:
    """Validate a document name and return its path, or raise 404."""
    if not _DOC_NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="Document not found")
    path = settings.client_docs_dir / slug / f"{name}.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Document not found")
    return path


@app.get("/d/{slug}/{name}", response_class=HTMLResponse)
def client_document(slug: str, name: str):
    """Public, shareable link to a curated client document (no auth)."""
    path = _resolve_document(slug, name)
    return HTMLResponse(path.read_text(encoding="utf-8"))


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
