"""Agency HQ · Time — internal time tracking across every client.

A room in Agency HQ, not a separate product: same reporting.db, same admin
login, same /agency/api surface. Nothing here is ever shown to clients.

Who can use it
  * The admin account (the reporting-dashboards login) sees and manages
    everything: team, rates, clients, categories, locks, every entry.
  * Team members are rows in time_members. Each gets a magic join link
    (/agency/join/<token>) that sets a df_team cookie — the same invite
    pattern as the client portal. A member can only track and see their own
    time; a manager can see and edit everyone's, but can't touch team, rates
    or settings. Neither role can reach the rest of Agency HQ (the snapshot
    and every other /agency/api route stay admin-only).

Clients
  The tracker reads the Agency HQ roster, so every client is already there.
  "Time-only" clients (prospects, pitches, one-off jobs that don't need
  reporting) live only in time_clients. Removing a client from time tracking
  archives it — history and exports keep working, and deleting a client from
  the roster never deletes its hours (entries carry no FK, and time_clients
  keeps the last-known name).

Money
  Each entry stores the bill rate resolved when it was saved (client override,
  else the member's default), so changing a rate never rewrites past months.
  Cost rates and margin are admin-only.
"""
import re
import secrets
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer

from app.auth import get_current_user
from app.config import settings
from app.db import get_conn


TEAM_COOKIE = "df_team"

SCHEMA = """
CREATE TABLE IF NOT EXISTS time_members (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    email          TEXT,
    role           TEXT NOT NULL DEFAULT 'member',   -- member | manager
    bill_rate      REAL,                              -- default charge-out rate / hour
    cost_rate      REAL,                              -- internal cost / hour (admin-only)
    capacity_hours REAL NOT NULL DEFAULT 37.5,        -- per week, for utilisation
    color          TEXT,
    invite_token   TEXT UNIQUE,
    active         INTEGER NOT NULL DEFAULT 1,
    last_login_at  TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    billable   INTEGER NOT NULL DEFAULT 1,           -- default for new entries
    active     INTEGER NOT NULL DEFAULT 1,
    sort       INTEGER NOT NULL DEFAULT 0
);

-- Per-client time settings. Roster clients get a row lazily; time-only
-- clients exist ONLY here (roster = 0).
CREATE TABLE IF NOT EXISTS time_clients (
    slug          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,                     -- last-known display name
    roster        INTEGER NOT NULL DEFAULT 1,        -- 1 = lives in the clients table
    bill_rate     REAL,                              -- overrides the member rate
    budget_hours  REAL,                              -- monthly retainer hours
    tracking      INTEGER NOT NULL DEFAULT 1,        -- 0 = archived from time tracking
    notes         TEXT,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id    INTEGER NOT NULL,
    client_slug  TEXT,                               -- NULL = internal / agency time
    category_id  INTEGER,
    entry_date   TEXT NOT NULL,                      -- YYYY-MM-DD
    minutes      INTEGER NOT NULL DEFAULT 0,
    description  TEXT,
    billable     INTEGER NOT NULL DEFAULT 1,
    bill_rate    REAL,                               -- resolved at save time
    started_at   TEXT,                               -- set while a timer runs
    running      INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_time_entries_date ON time_entries(entry_date);
CREATE INDEX IF NOT EXISTS ix_time_entries_member ON time_entries(member_id);

-- A locked week (Monday date) is signed off: members can't change it.
CREATE TABLE IF NOT EXISTS time_locks (
    week_start  TEXT PRIMARY KEY,
    locked_by   TEXT,
    locked_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
"""

DEFAULT_CATEGORIES = [
    ("SEO", 1), ("Content & copy", 1), ("Social media", 1), ("Paid media", 1),
    ("Reporting & analysis", 1), ("Web & development", 1), ("Design", 1),
    ("Strategy & planning", 1), ("Client meetings & calls", 1),
    ("Account management", 0), ("Internal admin", 0), ("Training", 0),
]

DEFAULT_SETTINGS = {
    "currency": "GBP",
    "round_minutes": "0",          # round stopped timers up to N minutes (0 = off)
    "week_hours_target": "37.5",
    "require_description": "0",
}
SETTING_KEYS = set(DEFAULT_SETTINGS)

INTERNAL = "__internal__"  # the pseudo-client for agency time in the UI


def init_time_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        if not conn.execute("SELECT 1 FROM time_categories LIMIT 1").fetchone():
            for i, (name, billable) in enumerate(DEFAULT_CATEGORIES):
                conn.execute(
                    "INSERT INTO time_categories (name, billable, sort) VALUES (?, ?, ?)",
                    (name, billable, i),
                )
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO time_settings (key, value) VALUES (?, ?)", (k, v))


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _monday(d: str) -> str:
    day = date.fromisoformat(d)
    return (day - timedelta(days=day.weekday())).isoformat()


# ------------------------------------------------------------------ auth

def _team_serializer() -> URLSafeSerializer:
    return URLSafeSerializer(settings.secret_key, salt="df-team")


class Actor:
    """Who is calling. Admin = the reporting login; otherwise a team member."""

    def __init__(self, label: str, admin: bool, member: Optional[dict]):
        self.label = label
        self.admin = admin
        self.member = member

    @property
    def role(self) -> str:
        return "admin" if self.admin else (self.member or {}).get("role", "member")

    @property
    def sees_all(self) -> bool:
        return self.admin or self.role == "manager"

    def can_touch(self, member_id: int) -> bool:
        return self.sees_all or (self.member is not None and self.member["id"] == member_id)


def _actor(request: Request) -> Optional[Actor]:
    user = get_current_user(request)
    if user and user == settings.admin_username:
        return Actor(user, True, None)
    raw = request.cookies.get(TEAM_COOKIE)
    if not raw:
        return None
    try:
        data = _team_serializer().loads(raw)
    except BadSignature:
        return None
    if not isinstance(data, dict) or "mid" not in data:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM time_members WHERE id = ? AND active = 1", (data["mid"],)
        ).fetchone()
    # A regenerated invite token (or archived member) kills the old session.
    if not row or row["invite_token"] != data.get("t"):
        return None
    m = dict(row)
    return Actor(m["name"], False, m)


def _require(request: Request) -> Actor:
    a = _actor(request)
    if not a:
        raise HTTPException(status_code=401, detail="Not signed in")
    return a


def _require_admin(request: Request) -> Actor:
    a = _require(request)
    if not a.admin:
        raise HTTPException(status_code=403, detail="Only the agency admin can change this")
    return a


# ------------------------------------------------------------------ helpers

def _settings(conn) -> dict:
    out = dict(DEFAULT_SETTINGS)
    for r in conn.execute("SELECT key, value FROM time_settings").fetchall():
        out[r["key"]] = r["value"]
    return out


def _member_out(m: dict, actor: Actor) -> dict:
    out = {
        "id": m["id"], "name": m["name"], "email": m["email"], "role": m["role"],
        "bill_rate": m["bill_rate"], "capacity_hours": m["capacity_hours"],
        "color": m["color"], "active": bool(m["active"]), "last_login_at": m["last_login_at"],
    }
    if actor.admin:
        out["cost_rate"] = m["cost_rate"]
        out["invite_url"] = f"{settings.app_url}/agency/join/{m['invite_token']}" if m["invite_token"] else None
    return out


def _clients(conn) -> list:
    """Roster clients merged with time settings + time-only clients."""
    rows = {r["slug"]: dict(r) for r in conn.execute("SELECT * FROM time_clients").fetchall()}
    out = []
    seen = set()
    for c in conn.execute("SELECT slug, display_name FROM clients ORDER BY display_name").fetchall():
        t = rows.get(c["slug"], {})
        seen.add(c["slug"])
        out.append({
            "slug": c["slug"], "name": c["display_name"], "roster": True,
            "bill_rate": t.get("bill_rate"), "budget_hours": t.get("budget_hours"),
            "tracking": bool(t.get("tracking", 1)), "notes": t.get("notes"),
        })
    for slug, t in rows.items():
        if slug in seen:
            continue
        # Time-only client, or a roster client since deleted (hours kept).
        out.append({
            "slug": slug, "name": t["name"], "roster": False,
            "removed_from_roster": bool(t["roster"]),
            "bill_rate": t["bill_rate"], "budget_hours": t["budget_hours"],
            "tracking": bool(t["tracking"]) and not t["roster"], "notes": t["notes"],
        })
    out.sort(key=lambda c: c["name"].lower())
    return out


def _client_name(conn, slug: Optional[str]) -> Optional[str]:
    if not slug:
        return None
    r = conn.execute("SELECT display_name FROM clients WHERE slug = ?", (slug,)).fetchone()
    if r:
        return r["display_name"]
    r = conn.execute("SELECT name FROM time_clients WHERE slug = ?", (slug,)).fetchone()
    return r["name"] if r else None


def _ensure_time_client(conn, slug: str):
    """Snapshot a roster client's name into time_clients so its hours keep a
    name even if the client is later deleted from the roster."""
    r = conn.execute("SELECT display_name FROM clients WHERE slug = ?", (slug,)).fetchone()
    if not r:
        return
    conn.execute(
        """INSERT INTO time_clients (slug, name, roster, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(slug) DO UPDATE SET name = excluded.name, roster = 1""",
        (slug, r["display_name"], _now()),
    )


def _resolve_rate(conn, member_id: int, client_slug: Optional[str]) -> Optional[float]:
    if client_slug:
        r = conn.execute("SELECT bill_rate FROM time_clients WHERE slug = ?", (client_slug,)).fetchone()
        if r and r["bill_rate"] is not None:
            return r["bill_rate"]
    r = conn.execute("SELECT bill_rate FROM time_members WHERE id = ?", (member_id,)).fetchone()
    return r["bill_rate"] if r else None


def _entry_out(e: dict) -> dict:
    return {
        "id": e["id"], "member_id": e["member_id"], "client_slug": e["client_slug"],
        "category_id": e["category_id"], "date": e["entry_date"], "minutes": e["minutes"],
        "description": e["description"] or "", "billable": bool(e["billable"]),
        "bill_rate": e["bill_rate"], "running": bool(e["running"]), "started_at": e["started_at"],
        "created_by": e["created_by"], "updated_at": e["updated_at"],
    }


def _is_locked(conn, day: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM time_locks WHERE week_start = ?", (_monday(day),)
    ).fetchone())


def _check_lock(conn, actor: Actor, *days: str):
    if actor.admin:
        return
    for d in days:
        if d and _is_locked(conn, d):
            raise HTTPException(status_code=409, detail="That week is locked — ask the admin to unlock it")


def _valid_date(v) -> str:
    try:
        return date.fromisoformat(str(v)).isoformat()
    except ValueError:
        raise HTTPException(status_code=422, detail="Date must be YYYY-MM-DD")


def _num(v, field: str, allow_none=True) -> Optional[float]:
    if v is None or v == "":
        if allow_none:
            return None
        raise HTTPException(status_code=422, detail=f"{field} is required")
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{field} must be a number")
    if n < 0:
        raise HTTPException(status_code=422, detail=f"{field} can't be negative")
    return n


def _norm_client(conn, v) -> Optional[str]:
    if v in (None, "", INTERNAL):
        return None
    slug = str(v)
    if not _client_name(conn, slug):
        raise HTTPException(status_code=422, detail="Unknown client")
    return slug


def _norm_category(conn, v) -> Optional[int]:
    if v in (None, ""):
        return None
    try:
        cid = int(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Unknown category")
    if not conn.execute("SELECT 1 FROM time_categories WHERE id = ?", (cid,)).fetchone():
        raise HTTPException(status_code=422, detail="Unknown category")
    return cid


def _running_minutes(started_at: str) -> int:
    start = datetime.fromisoformat(started_at.rstrip("Z"))
    return max(0, int((datetime.utcnow() - start).total_seconds() // 60))


def _round(minutes: int, step: int) -> int:
    if step <= 0:
        return minutes
    return max(step, -(-minutes // step) * step)


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "client"


# ------------------------------------------------------------------ routes

router = APIRouter()


@router.get("/agency/join/{token}")
def team_join(token: str):
    with get_conn() as conn:
        m = conn.execute(
            "SELECT * FROM time_members WHERE invite_token = ? AND active = 1", (token,)
        ).fetchone()
        if not m:
            return JSONResponse(
                {"detail": "This invite link has expired — ask the admin for a new one."},
                status_code=404,
            )
        conn.execute("UPDATE time_members SET last_login_at = ? WHERE id = ?", (_now(), m["id"]))
    resp = RedirectResponse("/agency/#time", status_code=302)
    resp.set_cookie(
        TEAM_COOKIE,
        _team_serializer().dumps({"mid": m["id"], "t": token}),
        max_age=60 * 60 * 24 * 90,
        httponly=True,
        secure=settings.app_env == "production",
        samesite="lax",
    )
    return resp


@router.post("/agency/api/time/logout")
def team_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(TEAM_COOKIE)
    return resp


@router.get("/agency/api/time/bootstrap")
def bootstrap(request: Request):
    """Everything the Time room needs except entries (fetched by range)."""
    a = _require(request)
    with get_conn() as conn:
        members = [dict(r) for r in conn.execute("SELECT * FROM time_members ORDER BY active DESC, name").fetchall()]
        if not a.sees_all:
            # A member needs only themselves (plus names for nothing else).
            members = [m for m in members if m["id"] == a.member["id"]]
        cats = [
            {"id": r["id"], "name": r["name"], "billable": bool(r["billable"]), "active": bool(r["active"]), "sort": r["sort"]}
            for r in conn.execute("SELECT * FROM time_categories ORDER BY sort, name").fetchall()
        ]
        clients = _clients(conn)
        if not a.admin:
            for c in clients:
                c.pop("notes", None)
        running_sql = "SELECT * FROM time_entries WHERE running = 1"
        params: tuple = ()
        if not a.sees_all:
            running_sql += " AND member_id = ?"
            params = (a.member["id"],)
        running = [_entry_out(dict(r)) for r in conn.execute(running_sql, params).fetchall()]
        locks = [r["week_start"] for r in conn.execute("SELECT week_start FROM time_locks ORDER BY week_start").fetchall()]
        st = _settings(conn)
    return JSONResponse({
        "me": {
            "role": a.role, "admin": a.admin, "label": a.label,
            "member_id": a.member["id"] if a.member else None,
        },
        "settings": st,
        "members": [_member_out(m, a) for m in members],
        "categories": cats,
        "clients": clients,
        "running": running,
        "locks": locks,
        "server_now": _now(),
    })


@router.get("/agency/api/time/entries")
def list_entries(request: Request, start: str, end: str, member_id: Optional[int] = None):
    a = _require(request)
    start, end = _valid_date(start), _valid_date(end)
    sql = "SELECT * FROM time_entries WHERE entry_date BETWEEN ? AND ?"
    params: list = [start, end]
    if not a.sees_all:
        sql += " AND member_id = ?"
        params.append(a.member["id"])
    elif member_id:
        sql += " AND member_id = ?"
        params.append(member_id)
    sql += " ORDER BY entry_date DESC, created_at DESC"
    with get_conn() as conn:
        rows = [_entry_out(dict(r)) for r in conn.execute(sql, params).fetchall()]
    return JSONResponse({"entries": rows})


def _entry_payload(conn, a: Actor, body: dict, current: Optional[dict] = None) -> dict:
    cur = current or {}
    member_id = body.get("member_id", cur.get("member_id"))
    if member_id is None:
        if a.member:
            member_id = a.member["id"]
        else:
            raise HTTPException(status_code=422, detail="Pick who this time is for")
    member_id = int(member_id)
    if not a.can_touch(member_id):
        raise HTTPException(status_code=403, detail="You can only log your own time")
    if not conn.execute("SELECT 1 FROM time_members WHERE id = ?", (member_id,)).fetchone():
        raise HTTPException(status_code=422, detail="Unknown team member")
    client_slug = _norm_client(conn, body["client_slug"]) if "client_slug" in body else cur.get("client_slug")
    category_id = _norm_category(conn, body["category_id"]) if "category_id" in body else cur.get("category_id")
    day = _valid_date(body["date"]) if "date" in body else cur.get("entry_date") or date.today().isoformat()
    minutes = cur.get("minutes", 0)
    if "minutes" in body:
        minutes = int(round(_num(body["minutes"], "Duration", allow_none=False)))
        if minutes > 24 * 60:
            raise HTTPException(status_code=422, detail="That's more than 24 hours in one entry")
    description = (body.get("description", cur.get("description")) or "").strip()
    if _settings(conn).get("require_description") == "1" and not description and not body.get("_timer"):
        raise HTTPException(status_code=422, detail="Add a short description of the work")
    if "billable" in body:
        billable = 1 if body["billable"] else 0
    elif current:
        billable = cur.get("billable", 1)
    else:
        cat = conn.execute("SELECT billable FROM time_categories WHERE id = ?", (category_id,)).fetchone() if category_id else None
        billable = (cat["billable"] if cat else 1) if client_slug else 0
    # Rate is fixed when the entry is saved; re-resolved only if who/which
    # client changed, so rate edits never rewrite history.
    if not current or member_id != cur.get("member_id") or client_slug != cur.get("client_slug"):
        rate = _resolve_rate(conn, member_id, client_slug)
    else:
        rate = cur.get("bill_rate")
    if a.admin and "bill_rate" in body:
        rate = _num(body["bill_rate"], "Rate")
    return {
        "member_id": member_id, "client_slug": client_slug, "category_id": category_id,
        "entry_date": day, "minutes": minutes, "description": description,
        "billable": billable, "bill_rate": rate,
    }


@router.post("/agency/api/time/entries")
async def create_entry(request: Request):
    a = _require(request)
    body = await request.json()
    with get_conn() as conn:
        p = _entry_payload(conn, a, body)
        if p["minutes"] <= 0:
            raise HTTPException(status_code=422, detail="Add a duration, e.g. 1:30 or 1.5h")
        _check_lock(conn, a, p["entry_date"])
        if p["client_slug"]:
            _ensure_time_client(conn, p["client_slug"])
        now = _now()
        cur = conn.execute(
            """INSERT INTO time_entries (member_id, client_slug, category_id, entry_date, minutes,
               description, billable, bill_rate, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (p["member_id"], p["client_slug"], p["category_id"], p["entry_date"], p["minutes"],
             p["description"], p["billable"], p["bill_rate"], a.label, now, now),
        )
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
    return JSONResponse({"entry": _entry_out(dict(row))})


def _load_entry(conn, a: Actor, entry_id: int) -> dict:
    row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Entry not found")
    e = dict(row)
    if not a.can_touch(e["member_id"]):
        raise HTTPException(status_code=403, detail="You can only change your own time")
    return e


@router.patch("/agency/api/time/entries/{entry_id}")
async def update_entry(entry_id: int, request: Request):
    a = _require(request)
    body = await request.json()
    with get_conn() as conn:
        e = _load_entry(conn, a, entry_id)
        p = _entry_payload(conn, a, body, e)
        _check_lock(conn, a, e["entry_date"], p["entry_date"])
        if not e["running"] and p["minutes"] <= 0:
            raise HTTPException(status_code=422, detail="Duration must be more than zero — delete the entry instead")
        if p["client_slug"]:
            _ensure_time_client(conn, p["client_slug"])
        conn.execute(
            """UPDATE time_entries SET member_id=?, client_slug=?, category_id=?, entry_date=?,
               minutes=?, description=?, billable=?, bill_rate=?, updated_at=? WHERE id=?""",
            (p["member_id"], p["client_slug"], p["category_id"], p["entry_date"], p["minutes"],
             p["description"], p["billable"], p["bill_rate"], _now(), entry_id),
        )
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (entry_id,)).fetchone()
    return JSONResponse({"entry": _entry_out(dict(row))})


@router.delete("/agency/api/time/entries/{entry_id}")
def delete_entry(entry_id: int, request: Request):
    a = _require(request)
    with get_conn() as conn:
        e = _load_entry(conn, a, entry_id)
        _check_lock(conn, a, e["entry_date"])
        conn.execute("DELETE FROM time_entries WHERE id = ?", (entry_id,))
    return JSONResponse({"ok": True})


# ---- timer: one running entry per person; starting a new one stops the old

def _stop_running(conn, member_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM time_entries WHERE member_id = ? AND running = 1", (member_id,)
    ).fetchone()
    if not row:
        return None
    step = int(_settings(conn).get("round_minutes") or 0)
    minutes = _round(max(1, row["minutes"] + _running_minutes(row["started_at"])), step)
    conn.execute(
        "UPDATE time_entries SET running = 0, started_at = NULL, minutes = ?, updated_at = ? WHERE id = ?",
        (minutes, _now(), row["id"]),
    )
    return _entry_out(dict(conn.execute("SELECT * FROM time_entries WHERE id = ?", (row["id"],)).fetchone()))


@router.post("/agency/api/time/timer/start")
async def timer_start(request: Request):
    a = _require(request)
    body = await request.json()
    with get_conn() as conn:
        # Resume an existing (stopped) entry: keep its minutes, add from now.
        resume_id = body.get("resume_id")
        if resume_id:
            e = _load_entry(conn, a, int(resume_id))
            _check_lock(conn, a, date.today().isoformat())
            stopped = _stop_running(conn, e["member_id"])
            if e["entry_date"] != date.today().isoformat():
                # Resuming yesterday's task starts a fresh entry for today.
                body = {
                    "member_id": e["member_id"], "client_slug": e["client_slug"] or INTERNAL,
                    "category_id": e["category_id"], "description": e["description"],
                    "billable": bool(e["billable"]),
                }
            else:
                conn.execute(
                    "UPDATE time_entries SET running = 1, started_at = ?, updated_at = ? WHERE id = ?",
                    (_now(), _now(), e["id"]),
                )
                row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (e["id"],)).fetchone()
                return JSONResponse({"entry": _entry_out(dict(row)), "stopped": stopped})
        body = {**body, "date": date.today().isoformat(), "minutes": 0, "_timer": True}
        p = _entry_payload(conn, a, body)
        _check_lock(conn, a, p["entry_date"])
        stopped = _stop_running(conn, p["member_id"])
        if p["client_slug"]:
            _ensure_time_client(conn, p["client_slug"])
        now = _now()
        cur = conn.execute(
            """INSERT INTO time_entries (member_id, client_slug, category_id, entry_date, minutes,
               description, billable, bill_rate, started_at, running, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?)""",
            (p["member_id"], p["client_slug"], p["category_id"], p["entry_date"],
             p["description"], p["billable"], p["bill_rate"], now, a.label, now, now),
        )
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
    return JSONResponse({"entry": _entry_out(dict(row)), "stopped": stopped})


@router.post("/agency/api/time/timer/stop")
async def timer_stop(request: Request):
    a = _require(request)
    body = await request.json()
    member_id = int(body.get("member_id") or (a.member["id"] if a.member else 0))
    if not member_id or not a.can_touch(member_id):
        raise HTTPException(status_code=403, detail="You can only stop your own timer")
    with get_conn() as conn:
        stopped = _stop_running(conn, member_id)
    if not stopped:
        raise HTTPException(status_code=404, detail="No timer running")
    return JSONResponse({"entry": stopped})


# ---- team (admin)

def _member_fields(body: dict, partial: bool) -> dict:
    out = {}
    if "name" in body or not partial:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="Name is required")
        out["name"] = name
    if "email" in body:
        out["email"] = (body.get("email") or "").strip() or None
    if "role" in body:
        if body["role"] not in ("member", "manager"):
            raise HTTPException(status_code=422, detail="Role must be member or manager")
        out["role"] = body["role"]
    for k, label in (("bill_rate", "Bill rate"), ("cost_rate", "Cost rate")):
        if k in body:
            out[k] = _num(body[k], label)
    if "capacity_hours" in body:
        out["capacity_hours"] = _num(body["capacity_hours"], "Capacity") or 0
    if "color" in body:
        out["color"] = body.get("color") or None
    if "active" in body:
        out["active"] = 1 if body["active"] else 0
    return out


@router.post("/agency/api/time/members")
async def create_member(request: Request):
    _require_admin(request)
    f = _member_fields(await request.json(), partial=False)
    f.setdefault("role", "member")
    f.setdefault("capacity_hours", 37.5)
    f["invite_token"] = secrets.token_urlsafe(24)
    f["created_at"] = _now()
    cols = ", ".join(f)
    with get_conn() as conn:
        cur = conn.execute(f"INSERT INTO time_members ({cols}) VALUES ({', '.join('?' * len(f))})", tuple(f.values()))
        return JSONResponse({"ok": True, "id": cur.lastrowid})


@router.patch("/agency/api/time/members/{member_id}")
async def update_member(member_id: int, request: Request):
    _require_admin(request)
    f = _member_fields(await request.json(), partial=True)
    if not f:
        return JSONResponse({"ok": True})
    with get_conn() as conn:
        if not conn.execute("SELECT 1 FROM time_members WHERE id = ?", (member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown team member")
        if f.get("active") == 0:
            _stop_running(conn, member_id)
        conn.execute(
            f"UPDATE time_members SET {', '.join(f'{k} = ?' for k in f)} WHERE id = ?",
            (*f.values(), member_id),
        )
    return JSONResponse({"ok": True})


@router.post("/agency/api/time/members/{member_id}/invite")
def regenerate_invite(member_id: int, request: Request):
    """New join link — the old link and any session made from it stop working."""
    _require_admin(request)
    token = secrets.token_urlsafe(24)
    with get_conn() as conn:
        cur = conn.execute("UPDATE time_members SET invite_token = ? WHERE id = ?", (token, member_id))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Unknown team member")
    return JSONResponse({"ok": True, "invite_url": f"{settings.app_url}/agency/join/{token}"})


@router.delete("/agency/api/time/members/{member_id}")
def delete_member(member_id: int, request: Request):
    _require_admin(request)
    with get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM time_entries WHERE member_id = ?", (member_id,)).fetchone()["n"]
        if n:
            raise HTTPException(
                status_code=409,
                detail=f"They have {n} time entr{'y' if n == 1 else 'ies'} — archive them instead so reports keep their hours",
            )
        conn.execute("DELETE FROM time_members WHERE id = ?", (member_id,))
    return JSONResponse({"ok": True})


# ---- clients (admin)

@router.post("/agency/api/time/clients")
async def create_time_client(request: Request):
    """A time-only client: a name to book hours against, no reporting setup."""
    a = _require_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Client name is required")
    with get_conn() as conn:
        base = _slugify(name)
        slug, i = base, 2
        while conn.execute(
            "SELECT 1 FROM clients WHERE slug = ? UNION SELECT 1 FROM time_clients WHERE slug = ?", (slug, slug)
        ).fetchone():
            slug, i = f"{base}-{i}", i + 1
        conn.execute(
            """INSERT INTO time_clients (slug, name, roster, bill_rate, budget_hours, tracking, notes, updated_at)
               VALUES (?, ?, 0, ?, ?, 1, ?, ?)""",
            (slug, name, _num(body.get("bill_rate"), "Rate"), _num(body.get("budget_hours"), "Budget"),
             (body.get("notes") or "").strip() or None, _now()),
        )
    return JSONResponse({"ok": True, "slug": slug})


@router.patch("/agency/api/time/clients/{slug}")
async def update_time_client(slug: str, request: Request):
    _require_admin(request)
    body = await request.json()
    with get_conn() as conn:
        name = _client_name(conn, slug)
        if not name:
            raise HTTPException(status_code=404, detail="Unknown client")
        in_roster = bool(conn.execute("SELECT 1 FROM clients WHERE slug = ?", (slug,)).fetchone())
        conn.execute(
            """INSERT INTO time_clients (slug, name, roster, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(slug) DO NOTHING""",
            (slug, name, 1 if in_roster else 0, _now()),
        )
        sets, vals = [], []
        if "name" in body and not in_roster:
            n = (body.get("name") or "").strip()
            if not n:
                raise HTTPException(status_code=422, detail="Client name is required")
            sets.append("name = ?"); vals.append(n)
        if "bill_rate" in body:
            sets.append("bill_rate = ?"); vals.append(_num(body["bill_rate"], "Rate"))
        if "budget_hours" in body:
            sets.append("budget_hours = ?"); vals.append(_num(body["budget_hours"], "Budget"))
        if "tracking" in body:
            sets.append("tracking = ?"); vals.append(1 if body["tracking"] else 0)
        if "notes" in body:
            sets.append("notes = ?"); vals.append((body.get("notes") or "").strip() or None)
        if sets:
            sets.append("updated_at = ?"); vals.append(_now())
            conn.execute(f"UPDATE time_clients SET {', '.join(sets)} WHERE slug = ?", (*vals, slug))
    return JSONResponse({"ok": True})


@router.delete("/agency/api/time/clients/{slug}")
def delete_time_client(slug: str, request: Request):
    """Delete a time-only client that has no hours. Anything with history is
    archived instead (PATCH tracking=false) so reports stay whole. Roster
    clients are deleted from the Clients room, never from here."""
    _require_admin(request)
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM clients WHERE slug = ?", (slug,)).fetchone():
            raise HTTPException(status_code=409, detail="This client is on the Agency HQ roster — archive it from time tracking, or delete it in the Clients room")
        n = conn.execute("SELECT COUNT(*) AS n FROM time_entries WHERE client_slug = ?", (slug,)).fetchone()["n"]
        if n:
            raise HTTPException(status_code=409, detail=f"{n} time entr{'y' if n == 1 else 'ies'} are booked to this client — archive it instead")
        conn.execute("DELETE FROM time_clients WHERE slug = ?", (slug,))
    return JSONResponse({"ok": True})


# ---- categories (admin)

@router.post("/agency/api/time/categories")
async def create_category(request: Request):
    _require_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Category name is required")
    with get_conn() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM time_categories").fetchone()["s"]
        cur = conn.execute(
            "INSERT INTO time_categories (name, billable, sort) VALUES (?, ?, ?)",
            (name, 1 if body.get("billable", True) else 0, sort),
        )
    return JSONResponse({"ok": True, "id": cur.lastrowid})


@router.patch("/agency/api/time/categories/{cat_id}")
async def update_category(cat_id: int, request: Request):
    _require_admin(request)
    body = await request.json()
    sets, vals = [], []
    if "name" in body:
        n = (body.get("name") or "").strip()
        if not n:
            raise HTTPException(status_code=422, detail="Category name is required")
        sets.append("name = ?"); vals.append(n)
    for k in ("billable", "active"):
        if k in body:
            sets.append(f"{k} = ?"); vals.append(1 if body[k] else 0)
    if "sort" in body:
        sets.append("sort = ?"); vals.append(int(body["sort"]))
    if sets:
        with get_conn() as conn:
            conn.execute(f"UPDATE time_categories SET {', '.join(sets)} WHERE id = ?", (*vals, cat_id))
    return JSONResponse({"ok": True})


@router.delete("/agency/api/time/categories/{cat_id}")
def delete_category(cat_id: int, request: Request):
    _require_admin(request)
    with get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM time_entries WHERE category_id = ?", (cat_id,)).fetchone()["n"]
        if n:
            raise HTTPException(status_code=409, detail=f"Used by {n} entr{'y' if n == 1 else 'ies'} — archive it instead")
        conn.execute("DELETE FROM time_categories WHERE id = ?", (cat_id,))
    return JSONResponse({"ok": True})


# ---- locks + settings (admin)

@router.post("/agency/api/time/locks")
async def lock_week(request: Request):
    a = _require_admin(request)
    body = await request.json()
    week = _monday(_valid_date(body.get("week_start")))
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO time_locks (week_start, locked_by, locked_at) VALUES (?, ?, ?)",
            (week, a.label, _now()),
        )
    return JSONResponse({"ok": True, "week_start": week})


@router.delete("/agency/api/time/locks/{week_start}")
def unlock_week(week_start: str, request: Request):
    _require_admin(request)
    with get_conn() as conn:
        conn.execute("DELETE FROM time_locks WHERE week_start = ?", (_monday(_valid_date(week_start)),))
    return JSONResponse({"ok": True})


@router.patch("/agency/api/time/settings")
async def update_settings(request: Request):
    _require_admin(request)
    body = await request.json()
    with get_conn() as conn:
        for k, v in body.items():
            if k in SETTING_KEYS:
                conn.execute("INSERT OR REPLACE INTO time_settings (key, value) VALUES (?, ?)", (k, str(v)))
        return JSONResponse({"ok": True, "settings": _settings(conn)})
