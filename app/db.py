"""SQLite database layer.

Tables: clients, reports, share_tokens, uploads, report_commentary,
client_users (portal logins), report_views (engagement), sentiment_cache.
"""
import json
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
    client_slug  TEXT NOT NULL,
    period       TEXT NOT NULL,
    headline     TEXT,
    standfirst   TEXT,
    notes_json   TEXT,
    actions_json TEXT,
    updated_at   TEXT NOT NULL,
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


def put_sentiment_cache(client_slug: str, content_hash: str, result: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO sentiment_cache (client_slug, content_hash, result_json, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(client_slug, content_hash) DO UPDATE SET
                   result_json = excluded.result_json, created_at = excluded.created_at""",
            (client_slug, content_hash, json.dumps(result), datetime.utcnow().isoformat()),
        )
