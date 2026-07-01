"""SQLite database layer. Tables: clients, reports, share_tokens."""
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
        # Seed Sportingtech as first client if not present
        existing = conn.execute(
            "SELECT slug FROM clients WHERE slug = ?", ("sportingtech",)
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO clients (slug, display_name, created_at) VALUES (?, ?, ?)",
                ("sportingtech", "Sportingtech", datetime.utcnow().isoformat()),
            )


def list_clients():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT slug, display_name FROM clients ORDER BY display_name"
        ).fetchall()
        return [dict(r) for r in rows]


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


def get_report_by_token(token: str):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT r.* FROM reports r
               JOIN share_tokens t ON t.report_id = r.id
               WHERE t.token = ?
               AND (t.expires_at IS NULL OR t.expires_at > ?)""",
            (token, datetime.utcnow().isoformat()),
        ).fetchone()
        return dict(row) if row else None
