"""LinkedIn analytics parser.

LinkedIn's company-page export is THREE separate .xls files (content,
followers, visitors), not one workbook - so the upload route stores each one
kind-suffixed (linkedin_company_{period}_content.xls etc.) and this parser
merges every linkedin_company* file in the period folder into one dict.

Quirks of the native export this parser absorbs:
- Files are legacy BIFF .xls (needs xlrd, not openpyxl).
- Row 0 of each sheet is a human title ("Aggregated engagement metric...");
  the real header is the row below it, so headers are found by content.
- There is no absolute follower total anywhere - only daily NEW followers
  plus demographic breakdowns. The total is estimated as the largest
  demographic-sheet sum (buckets are complete except Location's top-100 cap).

Also still supports a single multi-sheet workbook and the simple CSV format
from the Google Form workflow for exec posts.
"""
from pathlib import Path
import pandas as pd

EXPORT_KINDS = ("content", "followers", "visitors")

# Cells that mark a header row, per sheet family.
_HEADER_MARKERS = {
    "Date", "Post title", "Location", "Job function",
    "Seniority", "Industry", "Company size",
}


def parse_linkedin(path: Path) -> dict:
    result = {
        "followers": None,
        "follower_growth": None,
        "impressions": None,
        "engagements": None,
        "top_posts": [],
        "page_views": None,
        "unique_visitors": None,
        "kinds": [],
    }

    for f in _sibling_files(path):
        try:
            if f.suffix.lower() in (".xlsx", ".xls"):
                sheets = pd.read_excel(f, sheet_name=None, header=None)
                parsed = _parse_sheets(sheets)
            else:
                df = pd.read_csv(f, encoding="utf-8", on_bad_lines="skip")
                parsed = _parse_generic(df)
        except Exception:
            continue
        kinds = parsed.pop("kinds", [])
        result["kinds"] = sorted(set(result["kinds"]) | set(kinds))
        result.update({k: v for k, v in parsed.items() if v not in (None, [])})

    return result


def _sibling_files(path: Path) -> list:
    """Every linkedin_company* file in the same period folder, so one parse
    call sees all three exports however the build found its way here."""
    try:
        files = sorted(p for p in path.parent.glob("linkedin_company*") if p.is_file())
    except OSError:
        files = []
    if path not in files:
        files.append(path)
    return files


def detect_export_kind(path: Path, original_name: str = "") -> str | None:
    """Which of LinkedIn's three exports this file is - by sheet content
    first, filename keywords as fallback. None when unrecognisable."""
    try:
        sheets = pd.read_excel(path, sheet_name=None, header=None)
        found = {kind for kind, _tables in _classify_sheets(sheets)}
        if len(found) == 1:
            return found.pop()
        if len(found) > 1:
            return None  # genuine multi-part workbook - keep un-suffixed
    except Exception:
        pass
    name = (original_name or path.name).lower()
    for kind in EXPORT_KINDS:
        if kind in name:
            return kind
    if "post" in name:
        return "content"
    if "visitor" in name or "page" in name:
        return "visitors"
    return None


def _classify_sheets(sheets: dict):
    """Yield (kind, table) for every sheet we can identify."""
    for name, raw in sheets.items():
        df = _promote_header(raw)
        if df is None:
            continue
        cols = [str(c).lower() for c in df.columns]
        has = lambda frag: any(frag in c for c in cols)
        if has("post title"):
            yield "content", ("posts", df)
        elif has("date") and has("impressions"):
            yield "content", ("daily", df)
        elif has("date") and has("page views"):
            yield "visitors", ("daily", df)
        elif has("date") and has("follower"):
            yield "followers", ("daily", df)
        elif len(df.columns) == 2 and has("total followers"):
            yield "followers", ("demographic", df)


def _promote_header(raw: pd.DataFrame):
    """The export puts a title line above the real header - find the header
    row by its known column names and promote it."""
    for i in range(min(4, len(raw))):
        cells = {str(v).strip() for v in raw.iloc[i].tolist()}
        if cells & _HEADER_MARKERS:
            df = raw.iloc[i + 1:].copy()
            df.columns = [str(c).strip() for c in raw.iloc[i].tolist()]
            return df.dropna(how="all")
    return None


def _num(series) -> float:
    return pd.to_numeric(series, errors="coerce").fillna(0).sum()


def _col(df, *frags):
    """First column whose lowercase name contains every fragment."""
    for c in df.columns:
        lc = str(c).lower()
        if all(f in lc for f in frags):
            return c
    return None


def _parse_sheets(sheets: dict) -> dict:
    out = {"kinds": []}

    demo_totals = []
    for kind, (table, df) in _classify_sheets(sheets):
        if kind not in out["kinds"]:
            out["kinds"].append(kind)

        if kind == "content" and table == "daily":
            imp = _col(df, "impressions", "total") or _col(df, "impressions")
            if imp:
                out["impressions"] = int(_num(df[imp]))
            parts = [
                _col(df, "clicks", "total") or _col(df, "clicks"),
                _col(df, "reactions", "total") or _col(df, "reactions"),
                _col(df, "comments", "total") or _col(df, "comments"),
                _col(df, "reposts", "total") or _col(df, "reposts"),
            ]
            if any(parts):
                out["engagements"] = int(sum(_num(df[c]) for c in parts if c))

        elif kind == "content" and table == "posts":
            title = _col(df, "post title") or _col(df, "title")
            imp = _col(df, "impressions")
            if title and imp:
                sub = df[[title, imp]].copy()
                sub[imp] = pd.to_numeric(sub[imp], errors="coerce")
                sub = sub.dropna()
                top = sub.sort_values(imp, ascending=False).head(5)
                out["top_posts"] = [
                    {"title": str(r[title])[:100], "impressions": int(r[imp])}
                    for _, r in top.iterrows()
                ]

        elif kind == "followers" and table == "daily":
            gained = _col(df, "total followers") or _col(df, "followers")
            if gained:
                out["follower_growth"] = int(_num(df[gained]))

        elif kind == "followers" and table == "demographic":
            total = _col(df, "total followers")
            if total:
                demo_totals.append(int(_num(df[total])))

        elif kind == "visitors" and table == "daily":
            # Every column here starts with a section name and ends with a
            # device qualifier ("Overview page views (desktop)", "Total page
            # views (mobile)"...) - only the "(total)" suffix disambiguates.
            views = _col(df, "total page views", "(total)") or _col(df, "page views", "(total)") or _col(df, "page views")
            uniq = _col(df, "total unique visitors", "(total)") or _col(df, "unique visitors", "(total)") or _col(df, "unique visitors")
            if views:
                out["page_views"] = int(_num(df[views]))
            if uniq:
                out["unique_visitors"] = int(_num(df[uniq]))

    if demo_totals:
        out["followers"] = max(demo_totals)

    # Legacy multi-sheet workbook with a plain "Followers" sheet carrying an
    # absolute total column - prefer a real total over the demographic estimate.
    for name, raw in sheets.items():
        if "follower" in str(name).lower():
            df = _promote_header(raw)
            if df is not None and _col(df, "date") is None:
                continue
            if df is not None:
                total = _col(df, "total followers")
                gained = _col(df, "new followers")
                if total and gained:
                    try:
                        out["followers"] = int(pd.to_numeric(df[total], errors="coerce").dropna().iloc[-1])
                        out["follower_growth"] = int(_num(df[gained]))
                    except (IndexError, ValueError):
                        pass

    return out


def _parse_generic(df) -> dict:
    df.columns = [str(c).strip() for c in df.columns]
    out = {"kinds": []}
    for col, key in [
        ("Followers", "followers"),
        ("Impressions", "impressions"),
        ("Engagements", "engagements"),
    ]:
        if col in df.columns:
            try:
                out[key] = int(pd.to_numeric(df[col], errors="coerce").fillna(0).sum())
            except Exception:
                pass
    return out
