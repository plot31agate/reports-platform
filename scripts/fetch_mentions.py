"""Fetch a client's mention feeds (RSS or Atom) and write the mentions CSV.

Feeds come from the client's `mention_feeds` config (managed on the
workspace under "Mention feeds") - Google Alerts, publication RSS,
Talkwalker alerts, or any other RSS 2.0 / Atom feed.

Usage:
    python scripts/fetch_mentions.py --period 2026-07 --client sportingtech
    python scripts/fetch_mentions.py --period 2026-07 --client sportingtech --all   # include all dates

Output:
    data/{client}/{period}/mentions_{period}.csv

Alert feeds only keep the most recent ~20 entries each. For historical
months, compile from Gmail (search: from:googlealerts-noreply@google.com).
"""
import argparse
import csv
import html
import re
import ssl
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Fix macOS SSL certificate verification
ssl_ctx = ssl.create_default_context()
try:
    import certifi
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

ATOM = "{http://www.w3.org/2005/Atom}"


def _text(el):
    if el is None:
        return ""
    t = "".join(el.itertext()) if len(el) else (el.text or "")
    # Strip HTML tags from snippets
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t).strip()


def _domain(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return m.group(1) if m else ""


def _unwrap(url: str) -> str:
    """Google Alerts wraps the real URL in a redirect (…&url=<real>&…)."""
    m = re.search(r"[?&]url=([^&]+)", url)
    return urllib.parse.unquote(m.group(1)) if m else url


def _parse_atom(root) -> list[dict]:
    entries = []
    for entry in root.iter(f"{ATOM}entry"):
        link_el = entry.find(f"{ATOM}link")
        url_val = _unwrap(link_el.attrib.get("href", "") if link_el is not None else "")
        published = _text(entry.find(f"{ATOM}published")) or _text(entry.find(f"{ATOM}updated"))
        entries.append({
            "date": published[:10] if published else "",
            "source": _domain(url_val),
            "title": _text(entry.find(f"{ATOM}title")),
            "url": url_val,
            "snippet": (_text(entry.find(f"{ATOM}summary")) or _text(entry.find(f"{ATOM}content")))[:300],
        })
    return entries


def _parse_rss(root) -> list[dict]:
    entries = []
    for item in root.iter("item"):
        url_val = _unwrap(_text(item.find("link")))
        date = ""
        pub = _text(item.find("pubDate")) or _text(item.find("{http://purl.org/dc/elements/1.1/}date"))
        if pub:
            try:
                date = parsedate_to_datetime(pub).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                date = pub[:10]
        entries.append({
            "date": date,
            "source": _text(item.find("source")) or _domain(url_val),
            "title": _text(item.find("title")),
            "url": url_val,
            "snippet": _text(item.find("description"))[:300],
        })
    return entries


def fetch_feed(url: str) -> list[dict]:
    """Fetch one feed URL and normalise its entries. Handles Atom
    (Google Alerts et al.) and RSS 2.0 (publications, alert platforms)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ssl_ctx) as resp:
            body = resp.read()
    except Exception as e:
        print(f"  WARNING: could not fetch {url}: {e}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        print(f"  WARNING: not valid RSS/Atom XML {url}: {e}", file=sys.stderr)
        return []

    if root.tag == f"{ATOM}feed":
        return _parse_atom(root)
    return _parse_rss(root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", required=True, help="YYYY-MM e.g. 2026-07")
    parser.add_argument("--client", default="sportingtech")
    parser.add_argument("--all", action="store_true",
                        help="Include entries from any date (default: only the given month)")
    args = parser.parse_args()

    period = args.period
    try:
        datetime.strptime(period, "%Y-%m")
    except ValueError:
        print("ERROR: --period must be YYYY-MM", file=sys.stderr)
        sys.exit(1)

    from app.clients import get_client
    try:
        client = get_client(args.client)
    except KeyError:
        print(f"ERROR: unknown client {args.client}", file=sys.stderr)
        sys.exit(1)

    feeds = client.get("mention_feeds") or []
    if not feeds:
        print("ERROR: no mention feeds configured for this client - add RSS/Atom "
              "feed URLs on the workspace under Mention feeds.", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching {len(feeds)} mention feeds for {period}...")
    all_entries = []
    for feed_url in feeds:
        entries = fetch_feed(feed_url)
        print(f"  {len(entries):2d} entries — {feed_url[:80]}")
        all_entries.extend(entries)

    if not args.all:
        all_entries = [e for e in all_entries if e["date"].startswith(period)]

    # Deduplicate by URL
    seen = set()
    deduped = []
    for e in all_entries:
        if e["url"] and e["url"] not in seen:
            seen.add(e["url"])
            deduped.append(e)

    deduped.sort(key=lambda e: e["date"])

    out_dir = Path(__file__).parent.parent / "data" / args.client / period
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"mentions_{period}.csv"

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "source", "title", "url", "snippet"])
        writer.writeheader()
        for e in deduped:
            writer.writerow(e)

    print(f"\n{len(deduped)} mentions written to {out_path}")
    if len(deduped) == 0:
        print("\nNOTE: 0 entries for this period.")
        print("Alert feeds only keep the most recent ~20 entries each.")
        print("For historical months, export from Gmail:")
        print("  Search: from:googlealerts-noreply@google.com")
        print("  Filter by date range, copy titles/URLs into the CSV manually.")


if __name__ == '__main__':
    main()
