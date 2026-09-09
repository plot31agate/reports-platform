#!/usr/bin/env python3
"""hq_builder.py — the unattended Client HQ build runner.

Agency HQ's "Create HQ" button enqueues a build job in reporting.db (the
hq_build_jobs table) and flips the client to "building". This out-of-process
worker is what actually builds the site + portal: it claims queued jobs and,
for each, runs the client-hq skill through the Claude Code CLI, streaming the
build output back into the job's log so the operator watches it live in the UI.

Why a separate process, not the web app: a web request must never spawn an
agentic deploy (it creates real GitHub repos and pushes live over FTPS). The
app owns the queue; this runner owns the doing. Run it wherever the build
credentials live — the same box as the app, or a build host.

    # one pass over the queue, then exit (good for cron / testing)
    python scripts/hq_builder.py --once

    # stay up and poll forever (systemd / a screen session)
    python scripts/hq_builder.py

Modes
-----
Dry-run (DEFAULT, safe): simulates each build step and marks the job live with
a placeholder portal URL. Proves the whole pipeline without touching GitHub,
FTPS, or spending tokens. This is what runs unless you opt into live.

Live (opt-in): set HQ_BUILDER_LIVE=1 (or pass --live). The runner shells out to
the Claude Code CLI to run the client-hq skill for real. Requires:
  - `claude` on PATH (the Claude Code CLI), authenticated on this host
  - the GitHub credential this machine already uses (git + keychain/token)
  - the client's FTPS/deploy credentials, per the client-hq skill's intake
If `claude` isn't found in live mode, the job fails with a clear message rather
than pretending — no fake "live".
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db import (  # noqa: E402
    claim_next_hq_build_job,
    append_hq_build_log,
    finish_hq_build_job,
    get_hq_build_job,
    patch_client_agency,
)

REPO_ROOT = Path(__file__).parent.parent.parent  # the reporting-dashboards checkout
LOCAL_SITES = REPO_ROOT.parent                    # ~/Local Sites — where sibling checkouts live
REFERENCE = LOCAL_SITES / "aera-house-full"       # the client-hq reference the skill re-points
REFERENCE_REMOTE = "https://github.com/plot31agate/aerahouse.git"


def log(job_id: int, line: str) -> None:
    """Append one timestamped line to the job log and echo it to the console."""
    stamp = datetime.utcnow().strftime("%H:%M:%S")
    text = f"[{stamp}] {line}\n"
    append_hq_build_log(job_id, text)
    sys.stdout.write(text)
    sys.stdout.flush()


def _cancelled(job_id: int) -> bool:
    row = get_hq_build_job(job_id)
    return bool(row) and row["status"] == "cancelled"


def _portal_url(pack: dict) -> str:
    domain = ((pack.get("hosting") or {}).get("domain") or "").strip().strip("/")
    if domain:
        return f"https://{domain}/portal/"
    return ""


def run_dry(job: dict) -> None:
    """Simulate the build so the end-to-end loop (queue -> log -> live) is real
    even without credentials. Every line here maps to a real client-hq step."""
    jid, pack = job["id"], job["build_pack"]
    slug = job["client_slug"]
    hosting = pack.get("hosting") or {}
    rooms = pack.get("rooms") or {}
    shipping = [k for k, v in rooms.items() if v == "yes"] or ["content_engine", "site_health"]
    steps = [
        f"DRY RUN — no repos created, nothing deployed. Building HQ for '{pack.get('name', slug)}'.",
        f"Clone reference {REFERENCE_REMOTE} → {hosting.get('owner', 'plot31agate')}/{hosting.get('repo_name', slug)} and re-point (user creates the empty repo; git over HTTPS)",
        "Writing CLIENT.md from the build spec (stands in for the intake interview)",
        "Scaffolding marketing site: " + ", ".join((pack.get("site") or {}).get("pages", []) or ["Home"]),
        "Applying brand tokens to site/css/style.css: " + json.dumps(pack.get("brand") or {}),
        "Wiring three path-filtered FTPS workflows (site/builder/portal) + deploy webhook token",
        "Standing up portal rooms: " + ", ".join(shipping),
        "Seeding content strands: " + ", ".join((pack.get("content_strands") or []) or ["(none drafted)"]),
        "Running first site health sweep",
        "Build complete.",
    ]
    for s in steps:
        if _cancelled(jid):
            log(jid, "Cancelled by operator — stopping.")
            return
        log(jid, s)
        time.sleep(1.2)
    url = _portal_url(pack) or "https://example.com/portal/"
    patch_client_agency(slug, {"portalStatus": "live", "portalKind": "external", "portalUrl": url})
    finish_hq_build_job(jid, "live", portal_url=url)
    log(jid, f"Client HQ is live (simulated): {url}")


def _live_preflight(jid: int, pack: dict) -> str | None:
    """Return an error string if a real build can't proceed, else None. Checks
    the prerequisites the client-hq skill assumes: the Claude Code CLI, and the
    reference implementation it re-points (local checkout or the remote)."""
    from shutil import which
    if not which("claude"):
        return "Claude Code CLI ('claude') not found on PATH"
    if REFERENCE.is_dir():
        log(jid, f"Reference checkout found: {REFERENCE}")
    else:
        log(jid, f"No local reference at {REFERENCE}; checking the remote {REFERENCE_REMOTE} …")
        try:
            r = subprocess.run(["git", "ls-remote", REFERENCE_REMOTE, "HEAD"],
                               capture_output=True, text=True, timeout=30,
                               env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
            if r.returncode != 0 or not r.stdout.strip():
                return ("client-hq reference repo not reachable (plot31agate/aerahouse) and "
                        "no local checkout — can't clone the portal to re-point")
        except Exception as e:  # noqa: BLE001
            return f"Could not reach the client-hq reference repo: {e}"
    # Credentials Claude cannot invent — surface, don't block (the skill and its
    # vault reads handle what's present; a deploy just can't finish without them).
    need = pack.get("operator_required") or []
    if need:
        log(jid, "Operator-supplied inputs the deploy will need (from the vault or you): "
                 + "; ".join(need))
    return None


def run_live(job: dict) -> None:
    """Run the client-hq skill for real via the Claude Code CLI, streaming its
    output into the job log. Fails loudly if a prerequisite is missing."""
    jid, pack = job["id"], job["build_pack"]
    slug = job["client_slug"]

    err = _live_preflight(jid, pack)
    if err:
        finish_hq_build_job(jid, "failed", error=err)
        log(jid, f"FAILED preflight: {err}. Fix it on the build host, or run in dry-run mode.")
        return
    from shutil import which
    cli = which("claude")

    # Hand the build spec to the skill via a temp file it reads as the intake.
    tmp = Path(tempfile.gettempdir()) / f"hq-build-{slug}-{jid}.json"
    tmp.write_text(json.dumps(pack, indent=2))
    ref_line = (f"Use the local reference checkout at {REFERENCE} as the source to clone and re-point."
                if REFERENCE.is_dir()
                else f"Clone the reference repo {REFERENCE_REMOTE} to re-point.")
    prompt = (
        f"Run the client-hq skill to build the full Client HQ for '{pack.get('name', slug)}'. "
        "This is an UNATTENDED build: do NOT run the intake interview and do NOT wait for "
        f"design-direction sign-off — take every intake answer from this build spec: {tmp}. "
        "Write it to CLIENT.md in the new repo, then proceed through the skill's phases. "
        f"{ref_line} "
        f"Create the client's checkout under {LOCAL_SITES}/{pack.get('slug', slug)}. "
        "Credentials and hosting facts you don't have are listed under operator_required in the "
        "spec — read any that exist from the client's vault; if a deploy step lacks its "
        "credential, scaffold and commit what you can, log clearly what's blocked, and continue "
        "rather than stopping. Provision the repo, deploy where possible, and stand up the portal."
    )
    log(jid, f"LIVE build — invoking Claude Code CLI for '{pack.get('name', slug)}'.")
    log(jid, f"Build spec (intake) written to {tmp}")

    try:
        proc = subprocess.Popen(
            [cli, "-p", prompt, "--permission-mode", "acceptEdits"],
            cwd=str(LOCAL_SITES), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
    except Exception as e:  # noqa: BLE001
        finish_hq_build_job(jid, "failed", error=f"Could not start claude: {e}")
        log(jid, f"FAILED to start claude: {e}")
        return

    assert proc.stdout is not None
    for line in proc.stdout:
        if _cancelled(jid):
            proc.terminate()
            log(jid, "Cancelled by operator — terminated the build.")
            return
        append_hq_build_log(jid, line)
        sys.stdout.write(line)
        sys.stdout.flush()
    code = proc.wait()

    if code == 0:
        url = _portal_url(pack)
        patch = {"portalStatus": "live", "portalKind": "external"}
        if url:
            patch["portalUrl"] = url
        patch_client_agency(slug, patch)
        finish_hq_build_job(jid, "live", portal_url=url or None)
        log(jid, f"Build finished (exit 0). Client HQ live{f' at {url}' if url else ''}.")
    else:
        finish_hq_build_job(jid, "failed", error=f"claude exited {code}")
        log(jid, f"FAILED: claude exited {code}.")


def process_one(live: bool) -> bool:
    """Claim and run one job. Returns True if a job was processed."""
    job = claim_next_hq_build_job()
    if not job:
        return False
    jid = job["id"]
    log(jid, f"Claimed build job #{jid} for '{job['client_slug']}' "
             f"({'LIVE' if live else 'dry-run'}).")
    try:
        (run_live if live else run_dry)(job)
    except Exception as e:  # noqa: BLE001
        finish_hq_build_job(jid, "failed", error=str(e)[:200])
        log(jid, f"FAILED with error: {e}")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="Client HQ unattended build runner")
    ap.add_argument("--once", action="store_true", help="drain the queue once, then exit")
    ap.add_argument("--live", action="store_true", help="run real builds via the Claude Code CLI")
    ap.add_argument("--interval", type=float, default=5.0, help="poll seconds when staying up")
    args = ap.parse_args()

    live = args.live or os.environ.get("HQ_BUILDER_LIVE") == "1"
    mode = "LIVE (real repos + deploys)" if live else "dry-run (safe, nothing deployed)"
    print(f"hq_builder starting — mode: {mode}")

    if args.once:
        worked = True
        while worked:
            worked = process_one(live)
        print("Queue drained.")
        return

    while True:
        if not process_one(live):
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
