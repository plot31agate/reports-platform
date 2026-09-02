"""Daily trend charts — the GA4 day-by-day lines with last month dashed behind.

Charts are rendered server-side as SVG data-URI <img> tags, the same trick as
the Ahrefs sparklines: inline <svg> is invisible to WeasyPrint, but an SVG
image renders in browsers and the PDF alike. Each chart plots the current
month as a solid line against the previous month dashed (aligned by day of
month), marks the peak day, and carries a one-line summary with the
month-on-month change — the spikes-at-a-glance view rather than a data dump.

Feeds off the ga4_daily source (API sync or a GA4 UI export upload).
"""
import base64
from datetime import datetime

# Chart geometry (viewBox units).
W, H = 720, 190
PAD_L, PAD_R, PAD_T, PAD_B = 10, 52, 14, 26

CUR_COLOUR = "#fb0ba8"   # DF magenta — the month being reported
PREV_COLOUR = "#8aa2b6"  # muted slate — last month, dashed
GRID = "#e9e2d1"
INK = "#173756"
MUTED = "#4a6076"

METRICS = [
    {"key": "users", "title": "Active users by day", "fmt": "int"},
    {"key": "new_users", "title": "New users by day", "fmt": "int"},
    {"key": "engagement_secs", "title": "Average engagement time by day", "fmt": "secs"},
]


def build_trends(parsed: dict, prev_parsed: dict, period: str) -> dict | None:
    cur_days = (((parsed or {}).get("ga4_daily") or {}).get("data") or {}).get("days") or []
    prev_days = (((prev_parsed or {}).get("ga4_daily") or {}).get("data") or {}).get("days") or []
    if not cur_days:
        return None

    charts = []
    for m in METRICS:
        cur = _series(cur_days, m["key"])
        if len([v for v in cur if v is not None]) < 5:
            continue
        prev = _series(prev_days, m["key"])
        charts.append({
            "key": m["key"],
            "title": m["title"],
            "svg": _chart_svg(cur, prev, m["fmt"]),
            "summary": _summary(cur, prev, m["fmt"], period),
            "peak": _peak_label(cur_days, cur, m["fmt"]),
        })
    if not charts:
        return None
    return {"charts": charts, "has_prev": bool(prev_days)}


def _series(days: list, key: str) -> list:
    """Metric values indexed by day of month (1-based), None where absent."""
    out = [None] * 31
    for d in days:
        try:
            idx = datetime.strptime(d["date"], "%Y-%m-%d").day - 1
        except (ValueError, KeyError):
            continue
        out[idx] = d.get(key)
    while out and out[-1] is None:
        out.pop()
    return out


def _summary(cur: list, prev: list, fmt: str, period: str) -> str:
    cur_vals = [v for v in cur if v is not None]
    prev_vals = [v for v in prev if v is not None]
    if not cur_vals:
        return ""
    if fmt == "secs":
        cur_total, label = sum(cur_vals) / len(cur_vals), "daily average"
        prev_total = sum(prev_vals) / len(prev_vals) if prev_vals else None
        shown = _fmt_secs(cur_total)
    else:
        cur_total, label = sum(cur_vals), "month total"
        prev_total = sum(prev_vals) if prev_vals else None
        shown = f"{int(cur_total):,}"
    out = f"{shown} {label}"
    if prev_total:
        pct = (cur_total - prev_total) / prev_total * 100
        if abs(pct) < 0.5:
            out += f" - level with {_prev_name(period)}"
        else:
            out += f" - {'up' if pct > 0 else 'down'} {abs(pct):.1f}% on {_prev_name(period)}"
    return out


def _peak_label(days: list, cur: list, fmt: str) -> str:
    vals = [(v, i) for i, v in enumerate(cur) if v is not None]
    if not vals:
        return ""
    v, i = max(vals)
    date = next((d["date"] for d in days
                 if d.get("date", "").endswith(f"-{i + 1:02d}")), None)
    day_name = ""
    if date:
        try:
            day_name = datetime.strptime(date, "%Y-%m-%d").strftime("%-d %b")
        except ValueError:
            day_name = f"day {i + 1}"
    shown = _fmt_secs(v) if fmt == "secs" else f"{int(v):,}"
    return f"Peak {shown} on {day_name}" if day_name else f"Peak {shown}"


def _prev_name(period: str) -> str:
    from datetime import timedelta
    try:
        dt = datetime.strptime(period, "%Y-%m")
    except ValueError:
        return "last month"
    return (dt.replace(day=1) - timedelta(days=1)).strftime("%B")


def _fmt_secs(secs) -> str:
    secs = int(round(secs))
    return f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60:02d}s"


def _fmt_axis(v, fmt: str) -> str:
    if fmt == "secs":
        return _fmt_secs(v)
    if v >= 10000:
        return f"{v / 1000:.0f}k"
    if v >= 1000:
        return f"{v / 1000:.1f}k"
    return f"{int(v)}"


def _chart_svg(cur: list, prev: list, fmt: str) -> str:
    n = max(len(cur), len(prev), 28)
    maxv = max([v for v in cur + prev if v is not None] or [1]) * 1.15 or 1
    plot_w = W - PAD_L - PAD_R
    plot_h = H - PAD_T - PAD_B

    def x(i):
        return PAD_L + (i / max(n - 1, 1)) * plot_w

    def y(v):
        return PAD_T + plot_h - (v / maxv) * plot_h

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
             f'font-family="Helvetica, Arial, sans-serif">']

    # Grid + right-hand value labels at 0 / half / full scale.
    for frac in (0, 0.5, 1):
        gy = PAD_T + plot_h - frac * plot_h
        parts.append(f'<line x1="{PAD_L}" y1="{gy:.1f}" x2="{PAD_L + plot_w}" y2="{gy:.1f}" '
                     f'stroke="{GRID}" stroke-width="1"/>')
        parts.append(f'<text x="{PAD_L + plot_w + 6}" y="{gy + 3.5:.1f}" font-size="10" '
                     f'fill="{MUTED}">{_fmt_axis(maxv * frac, fmt)}</text>')

    # Day-of-month ticks along the bottom.
    for day in [d for d in (1, 8, 15, 22, n) if d <= n]:
        tx = x(day - 1)
        parts.append(f'<text x="{tx:.1f}" y="{H - 8}" font-size="10" fill="{MUTED}" '
                     f'text-anchor="middle">{day}</text>')

    def polyline(series, colour, dashed):
        segs, seg = [], []
        for i, v in enumerate(series):
            if v is None:
                if seg:
                    segs.append(seg)
                    seg = []
                continue
            seg.append(f"{x(i):.1f},{y(v):.1f}")
        if seg:
            segs.append(seg)
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        for s in segs:
            if len(s) < 2:
                continue
            parts.append(f'<polyline points="{" ".join(s)}" fill="none" stroke="{colour}" '
                         f'stroke-width="{1.6 if dashed else 2.4}" stroke-linejoin="round" '
                         f'stroke-linecap="round"{dash}/>')

    polyline(prev, PREV_COLOUR, dashed=True)
    polyline(cur, CUR_COLOUR, dashed=False)

    # Peak marker on the current month.
    vals = [(v, i) for i, v in enumerate(cur) if v is not None]
    if vals:
        v, i = max(vals)
        parts.append(f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="4" fill="{INK}" '
                     f'stroke="#ffffff" stroke-width="1.5"/>')

    parts.append("</svg>")
    svg = "".join(parts)
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
