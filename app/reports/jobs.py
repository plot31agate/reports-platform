"""In-process background build jobs.

One build may run per client+period at a time. The admin UI polls
get_job() for live progress. Jobs live in memory — a restart clears them,
which is fine because the underlying build is idempotent and re-runnable.
"""
import threading
import traceback
from datetime import datetime
from typing import Optional

_lock = threading.Lock()
_jobs: dict = {}  # (client_slug, period) -> job dict


STAGE_LABELS = {
    "parsing": "Reading source files",
    "sentiment": "Scoring sentiment",
    "synthesis": "Writing recommendations",
    "rendering": "Rendering report + PDF",
    "saving": "Publishing",
}


def get_job(client_slug: str, period: str) -> Optional[dict]:
    with _lock:
        job = _jobs.get((client_slug, period))
        return dict(job) if job else None


def _update(client_slug: str, period: str, **fields):
    with _lock:
        job = _jobs.get((client_slug, period))
        if job:
            job.update(fields)


def start_build(client_slug: str, period: str) -> dict:
    """Kick off a build in a background thread. Returns the job state.

    If a build for this client+period is already running, returns it
    unchanged rather than starting a second one.
    """
    key = (client_slug, period)
    with _lock:
        existing = _jobs.get(key)
        if existing and existing["status"] == "running":
            return dict(existing)
        job = {
            "status": "running",
            "stage": "parsing",
            "stage_label": STAGE_LABELS["parsing"],
            "detail": "",
            "error": None,
            "ai_health": None,
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
        }
        _jobs[key] = job

    thread = threading.Thread(target=_run, args=(client_slug, period), daemon=True)
    thread.start()
    return dict(job)


def _run(client_slug: str, period: str):
    from app.reports.builder import build_report

    def progress(stage: str, detail: str = ""):
        _update(
            client_slug, period,
            stage=stage,
            stage_label=STAGE_LABELS.get(stage, stage),
            detail=detail,
        )

    try:
        result = build_report(client_slug, period, progress=progress)
        _update(
            client_slug, period,
            status="done",
            stage="done",
            stage_label="Done",
            detail="",
            ai_health=result.get("ai_health"),
            finished_at=datetime.utcnow().isoformat(),
        )
    except Exception as e:
        traceback.print_exc()
        _update(
            client_slug, period,
            status="error",
            stage="error",
            stage_label="Build failed",
            error=str(e)[:300],
            finished_at=datetime.utcnow().isoformat(),
        )
