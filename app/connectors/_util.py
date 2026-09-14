"""Shared helpers for API connectors."""
from datetime import date


class ConnectorError(Exception):
    """A connector problem with a message safe to show the operator."""


def period_range(period: str) -> tuple[str, str]:
    """'2026-06' -> ('2026-06-01', '2026-06-30'); a custom range
    '2026-06-03_2026-06-14' -> its own start/end. Either form is clamped to
    yesterday so APIs aren't asked for data that doesn't exist yet."""
    from app.periods import bounds
    b = bounds(period)
    if not b:
        raise ConnectorError(f"Period must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD, got {period}")
    start, end = b
    today = date.today()
    if end >= today:
        end = today if start >= today else date.fromordinal(today.toordinal() - 1)
        if end < start:
            raise ConnectorError(f"{period} hasn't started yet - nothing to sync")
    return start.isoformat(), end.isoformat()


def csv_escape(value) -> str:
    s = "" if value is None else str(value)
    if any(ch in s for ch in [",", '"', "\n", "\r"]):
        s = '"' + s.replace('"', '""') + '"'
    return s


def write_csv(dest, header: list, rows: list):
    """Write rows (list of lists) with header to dest path."""
    lines = [",".join(csv_escape(h) for h in header)]
    for row in rows:
        lines.append(",".join(csv_escape(v) for v in row))
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
