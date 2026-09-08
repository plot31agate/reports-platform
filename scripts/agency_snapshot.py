#!/usr/bin/env python3
"""agency_snapshot.py — read the reporting core (reporting.db) and emit the
state Agency HQ needs to render its roster snapshot.

This is the "everything feeds up into the core" bridge: the master portal never
talks to SQLite directly, it reads this JSON. In dev we write it into the Vite
app's public/ folder so `npm run dev` serves it at ./snapshot.json; in
production the same shape would come from a live endpoint. Clients that live
only in the field (the Client HQ brands like Aera House) aren't in this DB —
the front-end roster config supplies those and merges them on top.
"""
import sqlite3, json, os, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "reporting.db")
OUT = os.path.join(HERE, "..", "agency", "public", "snapshot.json")


def build():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    clients = []
    for c in con.execute("SELECT slug, display_name, config_json, created_at FROM clients ORDER BY display_name"):
        slug = c["slug"]
        try:
            cfg = json.loads(c["config_json"] or "{}")
        except Exception:
            cfg = {}

        reports = [
            {"period": r["period"], "status": r["status"], "updated_at": r["updated_at"]}
            for r in con.execute(
                "SELECT period, status, updated_at FROM reports WHERE client_slug=? ORDER BY period DESC",
                (slug,),
            )
        ]
        connections = [
            {
                "provider": r["provider"],
                "status": r["status"],
                "detail": r["status_detail"],
                "last_synced_at": r["last_synced_at"],
            }
            for r in con.execute(
                "SELECT provider, status, status_detail, last_synced_at FROM client_connections WHERE client_slug=?",
                (slug,),
            )
        ]

        # Vault metadata only — never a ciphertext or a plaintext password.
        secrets = [
            {
                "id": r["id"], "label": r["label"], "login_url": r["login_url"],
                "username": r["username"], "has_password": bool(r["secret_cipher"]),
                "notes": r["notes"], "updated_by": r["updated_by"], "updated_at": r["updated_at"],
                "last_revealed_at": r["last_revealed_at"], "last_revealed_by": r["last_revealed_by"],
            }
            for r in con.execute(
                "SELECT * FROM client_secrets WHERE client_slug=? ORDER BY label", (slug,)
            )
        ]
        agency = cfg.get("agency") if isinstance(cfg.get("agency"), dict) else {}

        clients.append(
            {
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
            }
        )

    con.close()
    # The static generator can't reach the server's VAULT_KEY, and reveals go
    # through the live API anyway, so a generated file marks the vault not-ready.
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "reporting.db",
        "vault_ready": False,
        "clients": clients,
    }


def main():
    data = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, indent=2)
    print(f"wrote {OUT} — {len(data['clients'])} clients from the core")


if __name__ == "__main__":
    main()
