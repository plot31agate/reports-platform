"""Reporting periods.

A period is the single key for a report - it is the URL segment, the data
folder name, the output filename and the DB unique key. Two forms exist,
both path-safe:

  'YYYY-MM'                    - a calendar month (the default)
  'YYYY-MM-DD_YYYY-MM-DD'      - a custom date range, start_end inclusive
"""
import calendar
import re
from datetime import date, datetime, timedelta

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
RANGE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$")


def custom_bounds(period) -> tuple | None:
    """(start_date, end_date) for a custom-range period, else None.
    Returns None for malformed dates or an end before the start."""
    m = RANGE_RE.match(period or "")
    if not m:
        return None
    try:
        start = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        end = datetime.strptime(m.group(2), "%Y-%m-%d").date()
    except ValueError:
        return None
    return (start, end) if start <= end else None


def is_month(period) -> bool:
    if not MONTH_RE.match(period or ""):
        return False
    try:
        datetime.strptime(period, "%Y-%m")
        return True
    except ValueError:
        return False


def is_valid(period) -> bool:
    return is_month(period) or custom_bounds(period) is not None


def make_custom(start_iso: str, end_iso: str) -> str:
    return f"{start_iso}_{end_iso}"


def bounds(period) -> tuple | None:
    """(start_date, end_date) inclusive for either period form, else None."""
    rng = custom_bounds(period)
    if rng:
        return rng
    if not is_month(period):
        return None
    dt = datetime.strptime(period, "%Y-%m")
    last = calendar.monthrange(dt.year, dt.month)[1]
    return date(dt.year, dt.month, 1), date(dt.year, dt.month, last)


def months_covered(period) -> list:
    """Every 'YYYY-MM' the period touches, ascending. Empty when invalid."""
    b = bounds(period)
    if not b:
        return []
    start, end = b
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def prev_period(period) -> str | None:
    """The comparison period: the prior calendar month, or for a custom range
    the equal-length window ending the day before it starts."""
    rng = custom_bounds(period)
    if rng:
        start, end = rng
        prev_end = start - timedelta(days=1)
        prev_start = prev_end - (end - start)
        return make_custom(prev_start.isoformat(), prev_end.isoformat())
    if not is_month(period):
        return None
    dt = datetime.strptime(period, "%Y-%m")
    return (dt.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")


def display(period) -> str:
    """'2026-06' -> 'June 2026'; '2026-06-03_2026-06-14' -> '3–14 June 2026';
    unknown strings come back unchanged."""
    rng = custom_bounds(period)
    if rng:
        start, end = rng
        if (start.year, start.month) == (end.year, end.month):
            return f"{start.day}–{end.day} {end.strftime('%B %Y')}"
        if start.year == end.year:
            return f"{start.day} {start.strftime('%B')} – {end.day} {end.strftime('%B %Y')}"
        return f"{start.day} {start.strftime('%B %Y')} – {end.day} {end.strftime('%B %Y')}"
    if is_month(period):
        return datetime.strptime(period, "%Y-%m").strftime("%B %Y")
    return period or ""


def short_display(period) -> str:
    """Compact label for strips and deltas: 'June', '3–14 Jun', '21 May – 2 Jun'."""
    rng = custom_bounds(period)
    if rng:
        start, end = rng
        if (start.year, start.month) == (end.year, end.month):
            return f"{start.day}–{end.day} {end.strftime('%b')}"
        return f"{start.day} {start.strftime('%b')} – {end.day} {end.strftime('%b')}"
    if is_month(period):
        return datetime.strptime(period, "%Y-%m").strftime("%B")
    return period or ""
