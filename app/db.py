"""SQLite database layer.

Tables: clients, reports, share_tokens, uploads, report_commentary,
client_users (portal logins), report_views (engagement), sentiment_cache.
"""
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

from app.config import settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
    slug         TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_slug  TEXT NOT NULL,
    period       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft',
    html_path    TEXT,
    pdf_path     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(client_slug, period),
    FOREIGN KEY(client_slug) REFERENCES clients(slug)
);

CREATE TABLE IF NOT EXISTS share_tokens (
    token        TEXT PRIMARY KEY,
    report_id    INTEGER NOT NULL,
    expires_at   TEXT,
    created_at   TEXT NOT NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id)
);

CREATE TABLE IF NOT EXISTS uploads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_slug  TEXT NOT NULL,
    period       TEXT NOT NULL,
    source_key   TEXT NOT NULL,
    filename     TEXT,
    stored_path  TEXT,
    uploaded_at  TEXT NOT NULL,
    parse_status TEXT NOT NULL DEFAULT 'empty',
    row_count    INTEGER,
    summary_json TEXT,
    UNIQUE(client_slug, period, source_key)
);

CREATE TABLE IF NOT EXISTS report_commentary (
    client_slug      TEXT NOT NULL,
    period           TEXT NOT NULL,
    headline         TEXT,
    standfirst       TEXT,
    notes_json       TEXT,
    actions_json     TEXT,
    ai_seed_json     TEXT,   -- what the AI last wrote, to tell seeded text from operator edits
    data_fingerprint TEXT,   -- hash of the data the last synthesis read
    updated_at       TEXT NOT NULL,
    UNIQUE(client_slug, period)
);

CREATE TABLE IF NOT EXISTS client_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_slug   TEXT NOT NULL,
    email         TEXT NOT NULL,
    name          TEXT,
    invite_token  TEXT UNIQUE NOT NULL,
    created_at    TEXT NOT NULL,
    last_login_at TEXT,
    revoked_at    TEXT,
    UNIQUE(client_slug, email),
    FOREIGN KEY(client_slug) REFERENCES clients(slug)
);

CREATE TABLE IF NOT EXISTS report_views (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_slug  TEXT NOT NULL,
    period       TEXT NOT NULL,
    channel      TEXT NOT NULL,   -- 'share' or 'portal'
    viewer       TEXT,            -- portal email, or share token prefix
    viewed_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentiment_cache (
    client_slug  TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE(client_slug, content_hash)
);

CREATE TABLE IF NOT EXISTS mention_overrides (
    client_slug  TEXT NOT NULL,
    period       TEXT NOT NULL,
    mention_key  TEXT NOT NULL,
    excluded     INTEGER NOT NULL DEFAULT 0,   -- 1 = operator removed it
    sentiment    TEXT,                          -- positive|neutral|negative, or NULL = use AI
    updated_at   TEXT NOT NULL,
    UNIQUE(client_slug, period, mention_key)
);

CREATE TABLE IF NOT EXISTS client_connections (
    client_slug    TEXT NOT NULL,
    provider       TEXT NOT NULL,
    config_json    TEXT NOT NULL,
    status         TEXT DEFAULT 'untested',   -- untested | ok | error
    status_detail  TEXT,
    last_synced_at TEXT,
    updated_at     TEXT NOT NULL,
    UNIQUE(client_slug, provider),
    FOREIGN KEY(client_slug) REFERENCES clients(slug)
);

CREATE TABLE IF NOT EXISTS agency_credentials (
    provider       TEXT PRIMARY KEY,
    config_json    TEXT NOT NULL,
    status         TEXT DEFAULT 'untested',   -- untested | ok | error
    status_detail  TEXT,
    updated_at     TEXT NOT NULL
);
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        # Lightweight migrations
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(clients)").fetchall()]
        if "config_json" not in cols:
            conn.execute("ALTER TABLE clients ADD COLUMN config_json TEXT")
        share_cols = [r["name"] for r in conn.execute("PRAGMA table_info(share_tokens)").fetchall()]
        if "revoked_at" not in share_cols:
            conn.execute("ALTER TABLE share_tokens ADD COLUMN revoked_at TEXT")
        comm_cols = [r["name"] for r in conn.execute("PRAGMA table_info(report_commentary)").fetchall()]
        if "ai_seed_json" not in comm_cols:
            conn.execute("ALTER TABLE report_commentary ADD COLUMN ai_seed_json TEXT")
        if "data_fingerprint" not in comm_cols:
            conn.execute("ALTER TABLE report_commentary ADD COLUMN data_fingerprint TEXT")

        # Migration: provider secrets used to live on per-client connections.
        # Keys are really agency-wide (one Ahrefs account for all clients), so
        # lift them into agency_credentials and strip them from client rows.
        from app.connectors import CONNECTOR_DEFS

        for cdef in CONNECTOR_DEFS:
            provider = cdef["provider"]
            secret_keys = [f["key"] for f in cdef.get("agency_fields", [])]
            if not secret_keys:
                continue
            client_rows = conn.execute(
                "SELECT client_slug, config_json FROM client_connections WHERE provider = ?",
                (provider,),
            ).fetchall()
            agency_exists = conn.execute(
                "SELECT provider FROM agency_credentials WHERE provider = ?", (provider,)
            ).fetchone()
            for row in client_rows:
                try:
                    cfg = json.loads(row["config_json"] or "{}")
                except (ValueError, TypeError):
                    continue
                secrets = {k: cfg[k] for k in secret_keys if cfg.get(k)}
                if secrets and not agency_exists:
                    conn.execute(
                        "INSERT INTO agency_credentials (provider, config_json, updated_at) VALUES (?, ?, ?)",
                        (provider, json.dumps(secrets), datetime.utcnow().isoformat()),
                    )
                    agency_exists = True
                if any(k in cfg for k in secret_keys):
                    for k in secret_keys:
                        cfg.pop(k, None)
                    conn.execute(
                        "UPDATE client_connections SET config_json = ? WHERE client_slug = ? AND provider = ?",
                        (json.dumps(cfg), row["client_slug"], provider),
                    )

        # Seed code-registry clients into the DB. The DB is the single source of
        # truth at runtime; code modules act only as seed data for first boot.
        from app.clients import CLIENTS

        for slug, config in CLIENTS.items():
            row = conn.execute(
                "SELECT slug, config_json FROM clients WHERE slug = ?", (slug,)
            ).fetchone()
            seed = {k: v for k, v in config.items() if k not in ("slug", "display_name")}
            if not row:
                conn.execute(
                    "INSERT INTO clients (slug, display_name, created_at, config_json) VALUES (?, ?, ?, ?)",
                    (slug, config["display_name"], datetime.utcnow().isoformat(), json.dumps(seed)),
                )
            elif not row["config_json"]:
                conn.execute(
                    "UPDATE clients SET config_json = ? WHERE slug = ?",
                    (json.dumps(seed), slug),
                )


def list_clients():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT slug, display_name, config_json FROM clients ORDER BY display_name"
        ).fetchall()
        return [dict(r) for r in rows]


def get_client_row(slug: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT slug, display_name, config_json FROM clients WHERE slug = ?", (slug,)
        ).fetchone()
        return dict(row) if row else None


def update_client_config_key(slug: str, key: str, value):
    """Set one key in a client's config_json, preserving the rest."""
    with get_conn() as conn:
        row = conn.execute("SELECT config_json FROM clients WHERE slug = ?", (slug,)).fetchone()
        if row is None:
            raise KeyError(f"Unknown client: {slug}")
        try:
            cfg = json.loads(row["config_json"]) if row["config_json"] else {}
        except (ValueError, TypeError):
            cfg = {}
        cfg[key] = value
        conn.execute("UPDATE clients SET config_json = ? WHERE slug = ?", (json.dumps(cfg), slug))


def create_client(slug: str, display_name: str, config_json: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO clients (slug, display_name, created_at, config_json) VALUES (?, ?, ?, ?)",
            (slug, display_name, datetime.utcnow().isoformat(), config_json),
        )


def list_reports(client_slug: Optional[str] = None):
    with get_conn() as conn:
        if client_slug:
            rows = conn.execute(
                """SELECT id, client_slug, period, status, html_path, pdf_path, updated_at
                   FROM reports WHERE client_slug = ? ORDER BY period DESC""",
                (client_slug,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, client_slug, period, status, html_path, pdf_path, updated_at
                   FROM reports ORDER BY period DESC, client_slug"""
            ).fetchall()
        return [dict(r) for r in rows]


def get_report(report_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
        return dict(row) if row else None


def upsert_report(client_slug: str, period: str, html_path: str, pdf_path: str):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM reports WHERE client_slug = ? AND period = ?",
            (client_slug, period),
        ).fetchone()
        if existing:
            conn.execute(
                """UPDATE reports SET status='published', html_path=?, pdf_path=?, updated_at=?
                   WHERE id=?""",
                (html_path, pdf_path, now, existing["id"]),
            )
            return existing["id"]
        cur = conn.execute(
            """INSERT INTO reports (client_slug, period, status, html_path, pdf_path, created_at, updated_at)
               VALUES (?, ?, 'published', ?, ?, ?, ?)""",
            (client_slug, period, html_path, pdf_path, now, now),
        )
        return cur.lastrowid


def data_months(client_slug: str) -> dict:
    """{period: {'source_count', 'changed_at'}} read from the data folder.

    The builder reads the disk, not the uploads table, so the disk is what
    decides whether a month can be generated. Anything that arrives outside
    the upload path (seeded, FTP'd, restored from a backup) exists here and
    nowhere else, so the workspace has to look at both.
    """
    out = {}
    root = settings.data_dir / client_slug
    if not root.is_dir():
        return out
    for folder in root.iterdir():
        if not folder.is_dir() or not re.match(r"^\d{4}-\d{2}$", folder.name):
            continue
        files = [f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")]
        if not files:
            continue
        newest = max(f.stat().st_mtime for f in files)
        out[folder.name] = {
            "source_count": len(files),
            "changed_at": datetime.utcfromtimestamp(newest).isoformat(),
        }
    return out


def get_report_layout(client_slug: str) -> dict:
    """The client's standing report layout: the structural choices made on the
    review screen that later months should inherit. Empty when never saved."""
    row = get_client_row(client_slug)
    if not row:
        return {}
    try:
        cfg = json.loads(row.get("config_json") or "{}")
    except (ValueError, TypeError):
        return {}
    layout = cfg.get("report_layout")
    return layout if isinstance(layout, dict) else {}


def save_report_layout(client_slug: str, layout: dict):
    update_client_config_key(client_slug, "report_layout", layout)


def report_index(client_slug: str) -> list:
    """Every month this client has a report or data for, newest first.

    Carries when the report was generated and when its data last changed, so
    the workspace can show what already exists and flag a report whose data
    has moved on since - the two things you need before regenerating over a
    month you may not have meant to touch.
    """
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT period,
                   MAX(report_updated) AS report_updated,
                   MAX(data_changed)   AS data_changed,
                   MAX(source_count)   AS source_count
            FROM (
                SELECT period, updated_at AS report_updated,
                       NULL AS data_changed, 0 AS source_count
                  FROM reports WHERE client_slug = ?
                UNION ALL
                SELECT period, NULL AS report_updated,
                       MAX(uploaded_at) AS data_changed, COUNT(*) AS source_count
                  FROM uploads WHERE client_slug = ? GROUP BY period
            )
            GROUP BY period
            ORDER BY period DESC
            """,
            (client_slug, client_slug),
        ).fetchall()

    on_disk = data_months(client_slug)
    merged = {}
    for r in rows:
        merged[r["period"]] = {
            "generated_at": r["report_updated"],
            "data_changed_at": r["data_changed"],
            "source_count": r["source_count"] or 0,
        }
    for period, info in on_disk.items():
        row = merged.setdefault(period, {"generated_at": None, "data_changed_at": None, "source_count": 0})
        # Prefer whichever record saw the data move most recently.
        row["source_count"] = max(row["source_count"], info["source_count"])
        if not row["data_changed_at"] or info["changed_at"] > row["data_changed_at"]:
            row["data_changed_at"] = info["changed_at"]

    out = []
    for period in sorted(merged, reverse=True):
        row = merged[period]
        generated, changed = row["generated_at"], row["data_changed_at"]
        out.append({
            "period": period,
            "generated_at": generated,
            "data_changed_at": changed,
            "source_count": row["source_count"],
            # Timestamps are ISO strings from utcnow(), so they compare as text.
            "stale": bool(generated and changed and changed > generated),
        })
    return out


def create_share_token(report_id: int, token: str, expires_at: Optional[str] = None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO share_tokens (token, report_id, expires_at, created_at)
               VALUES (?, ?, ?, ?)""",
            (token, report_id, expires_at, datetime.utcnow().isoformat()),
        )


def upsert_upload(client_slug, period, source_key, filename, stored_path, parse_status, row_count, summary_json):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO uploads (client_slug, period, source_key, filename, stored_path, uploaded_at, parse_status, row_count, summary_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_slug, period, source_key) DO UPDATE SET
                filename=excluded.filename, stored_path=excluded.stored_path,
                uploaded_at=excluded.uploaded_at, parse_status=excluded.parse_status,
                row_count=excluded.row_count, summary_json=excluded.summary_json
        """, (client_slug, period, source_key, filename, stored_path, now, parse_status, row_count, summary_json))


def list_uploads(client_slug, period):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM uploads WHERE client_slug=? AND period=? ORDER BY source_key",
            (client_slug, period)
        ).fetchall()
        return {r["source_key"]: dict(r) for r in rows}


def delete_uploads(client_slug, period):
    """Delete all upload records for a client+period. Returns the stored file paths."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT stored_path FROM uploads WHERE client_slug=? AND period=?",
            (client_slug, period)
        ).fetchall()
        conn.execute("DELETE FROM uploads WHERE client_slug=? AND period=?", (client_slug, period))
        return [r["stored_path"] for r in rows if r["stored_path"]]


def get_commentary(client_slug: str, period: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM report_commentary WHERE client_slug=? AND period=?",
            (client_slug, period),
        ).fetchone()
        return dict(row) if row else None


def upsert_commentary(client_slug, period, headline, standfirst, notes_json, actions_json):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO report_commentary (client_slug, period, headline, standfirst, notes_json, actions_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_slug, period) DO UPDATE SET
                headline=excluded.headline, standfirst=excluded.standfirst,
                notes_json=excluded.notes_json, actions_json=excluded.actions_json,
                updated_at=excluded.updated_at
        """, (client_slug, period, headline, standfirst, notes_json, actions_json, now))


def set_commentary_ai_state(client_slug, period, ai_seed_json, data_fingerprint):
    """Record what the AI last wrote and the data it read. Kept separate from
    upsert_commentary so review-screen saves never clobber it."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE report_commentary SET ai_seed_json=?, data_fingerprint=? WHERE client_slug=? AND period=?",
            (ai_seed_json, data_fingerprint, client_slug, period),
        )


def clear_commentary_text(client_slug: str, period: str):
    """Blank a period's written commentary so the next build reseeds it from
    fresh synthesis. Destructive by design and only ever operator-triggered:
    the merge cannot tell AI-seeded text from a hand-edit on rows written
    before ai_seed_json existed, so discarding is a choice, never automatic.
    Mention overrides and the report row are untouched."""
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            """UPDATE report_commentary
                  SET headline=NULL, standfirst=NULL, notes_json=NULL, actions_json=NULL,
                      ai_seed_json=NULL, data_fingerprint=NULL, updated_at=?
                WHERE client_slug=? AND period=?""",
            (now, client_slug, period),
        )


def get_report_by_token(token: str):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT r.* FROM reports r
               JOIN share_tokens t ON t.report_id = r.id
               WHERE t.token = ?
               AND t.revoked_at IS NULL
               AND (t.expires_at IS NULL OR t.expires_at > ?)""",
            (token, datetime.utcnow().isoformat()),
        ).fetchone()
        return dict(row) if row else None


def list_share_tokens(report_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT token, expires_at, created_at, revoked_at
               FROM share_tokens WHERE report_id = ? ORDER BY created_at DESC""",
            (report_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def revoke_share_token(token: str):
    with get_conn() as conn:
        conn.execute(
            "UPDATE share_tokens SET revoked_at = ? WHERE token = ?",
            (datetime.utcnow().isoformat(), token),
        )


# ------------------- portal users -------------------

def create_client_user(client_slug: str, email: str, name: str, invite_token: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO client_users (client_slug, email, name, invite_token, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (client_slug, email.lower().strip(), name, invite_token, datetime.utcnow().isoformat()),
        )


def list_client_users(client_slug: str):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM client_users WHERE client_slug = ? ORDER BY created_at",
            (client_slug,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_client_user(user_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM client_users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_client_user_by_invite(invite_token: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM client_users WHERE invite_token = ? AND revoked_at IS NULL",
            (invite_token,),
        ).fetchone()
        return dict(row) if row else None


def touch_client_user_login(user_id: int):
    with get_conn() as conn:
        conn.execute(
            "UPDATE client_users SET last_login_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), user_id),
        )


def revoke_client_user(user_id: int):
    with get_conn() as conn:
        conn.execute(
            "UPDATE client_users SET revoked_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), user_id),
        )


# ------------------- report views -------------------

def record_report_view(client_slug: str, period: str, channel: str, viewer: str = None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO report_views (client_slug, period, channel, viewer, viewed_at)
               VALUES (?, ?, ?, ?, ?)""",
            (client_slug, period, channel, viewer, datetime.utcnow().isoformat()),
        )


def report_view_stats(client_slug: str, period: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COUNT(*) AS total, MAX(viewed_at) AS last_viewed
               FROM report_views WHERE client_slug = ? AND period = ?""",
            (client_slug, period),
        ).fetchone()
        return {"total": row["total"], "last_viewed": row["last_viewed"]}


# ------------------- sentiment cache -------------------

def get_sentiment_cached(client_slug: str, content_hash: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT result_json FROM sentiment_cache WHERE client_slug = ? AND content_hash = ?",
            (client_slug, content_hash),
        ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["result_json"])
        except (ValueError, TypeError):
            return None


# ------------------- agency credentials -------------------

def upsert_agency_credential(provider: str, config_json: str):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO agency_credentials (provider, config_json, status, updated_at)
               VALUES (?, ?, 'untested', ?)
               ON CONFLICT(provider) DO UPDATE SET
                   config_json = excluded.config_json, status = 'untested',
                   status_detail = NULL, updated_at = excluded.updated_at""",
            (provider, config_json, now),
        )


def get_agency_credentials() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM agency_credentials").fetchall()
        return {r["provider"]: dict(r) for r in rows}


def get_agency_credential(provider: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM agency_credentials WHERE provider = ?", (provider,)
        ).fetchone()
        return dict(row) if row else None


def set_agency_credential_status(provider: str, status: str, detail: str = None):
    with get_conn() as conn:
        conn.execute(
            "UPDATE agency_credentials SET status=?, status_detail=?, updated_at=? WHERE provider=?",
            (status, detail, datetime.utcnow().isoformat(), provider),
        )


def delete_agency_credential(provider: str):
    with get_conn() as conn:
        conn.execute("DELETE FROM agency_credentials WHERE provider = ?", (provider,))


# ------------------- API connections -------------------

def upsert_connection(client_slug: str, provider: str, config_json: str):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO client_connections (client_slug, provider, config_json, status, updated_at)
               VALUES (?, ?, ?, 'untested', ?)
               ON CONFLICT(client_slug, provider) DO UPDATE SET
                   config_json = excluded.config_json, status = 'untested',
                   status_detail = NULL, updated_at = excluded.updated_at""",
            (client_slug, provider, config_json, now),
        )


def get_connections(client_slug: str) -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM client_connections WHERE client_slug = ?", (client_slug,)
        ).fetchall()
        return {r["provider"]: dict(r) for r in rows}


def get_connection(client_slug: str, provider: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM client_connections WHERE client_slug = ? AND provider = ?",
            (client_slug, provider),
        ).fetchone()
        return dict(row) if row else None


def set_connection_status(client_slug: str, provider: str, status: str, detail: str = None, synced: bool = False):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        if synced:
            conn.execute(
                """UPDATE client_connections SET status=?, status_detail=?, last_synced_at=?, updated_at=?
                   WHERE client_slug=? AND provider=?""",
                (status, detail, now, now, client_slug, provider),
            )
        else:
            conn.execute(
                """UPDATE client_connections SET status=?, status_detail=?, updated_at=?
                   WHERE client_slug=? AND provider=?""",
                (status, detail, now, client_slug, provider),
            )


def delete_connection(client_slug: str, provider: str):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM client_connections WHERE client_slug = ? AND provider = ?",
            (client_slug, provider),
        )


def put_sentiment_cache(client_slug: str, content_hash: str, result: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO sentiment_cache (client_slug, content_hash, result_json, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(client_slug, content_hash) DO UPDATE SET
                   result_json = excluded.result_json, created_at = excluded.created_at""",
            (client_slug, content_hash, json.dumps(result), datetime.utcnow().isoformat()),
        )


def get_mention_overrides(client_slug: str, period: str) -> dict:
    """Operator overrides for a period's mentions, keyed by mention_key:
    {key: {"excluded": bool, "sentiment": str|None}}."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT mention_key, excluded, sentiment FROM mention_overrides WHERE client_slug = ? AND period = ?",
            (client_slug, period),
        ).fetchall()
    return {
        r["mention_key"]: {"excluded": bool(r["excluded"]), "sentiment": r["sentiment"]}
        for r in rows
    }


def set_mention_overrides(client_slug: str, period: str, overrides: dict):
    """Replace the period's overrides. `overrides` is {key: {excluded, sentiment}};
    only rows that actually override something (excluded or a sentiment) are kept."""
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM mention_overrides WHERE client_slug = ? AND period = ?",
            (client_slug, period),
        )
        for key, ov in (overrides or {}).items():
            excluded = 1 if ov.get("excluded") else 0
            sentiment = ov.get("sentiment") or None
            if not excluded and not sentiment:
                continue
            conn.execute(
                """INSERT INTO mention_overrides (client_slug, period, mention_key, excluded, sentiment, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (client_slug, period, key, excluded, sentiment, now),
            )
