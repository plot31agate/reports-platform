"""Fetch Google Alerts RSS feeds and write a mentions CSV for the given period.

Usage:
    python scripts/fetch_mentions.py --period 2026-07
    python scripts/fetch_mentions.py --period 2026-07 --all   # include all dates, not just that month

Output:
    data/sportingtech/2026-07/mentions_2026-07.csv

Google Alerts RSS feeds only keep the most recent ~20 entries per feed.
For historical months, compile from Gmail (search: from:googlealerts-noreply@google.com).
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
from pathlib import Path

# Fix macOS SSL certificate verification
ssl_ctx = ssl.create_default_context()
try:
    import certifi
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

FEEDS = [
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/16170668821117914581",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/4360640709969990399",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/1303721399638411999",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/12133739773753703727",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/4664133647478171063",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/18446529224811404312",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/9277082318107763866",
    "https://www.google.co.uk/alerts/feeds/07184293393273308205/13625659024980385575",
]

NS = {"a": "http://www.w3.org/2005/Atom"}


def _text(el):
    if el is None:
        return ""
    t = el.text or ""
    # Strip HTML tags from snippets
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t).strip()


def fetch_feed(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ssl_ctx) as resp:
            body = resp.read()
    except Exception as e:
        print(f"  WARNING: could not fetch {url}: {e}", file=sys.stderr)
        return []

    root = ET.fromstring(body)
    feed_title = _text(root.find("a:title", NS))
    entries = []
    for entry in root.findall("a:entry", NS):
        title = _text(entry.find("a:title", NS))
        published = _text(entry.find("a:published", NS))
        link_el = entry.find("a:link", NS)
        url_val = link_el.attrib.get("href", "") if link_el is not None else ""
        # Google wraps the real URL — extract it
        real_url = re.search(r"url=([^&]+)", url_val)
        url_val = urllib.parse.unquote(real_url.group(1)) if real_url else url_val
        snippet = _text(entry.find("a:summary", NS) or entry.find("a:content", NS))
        # Source: domain from the real URL
        domain = re.search(r"https?://(?:www\.)?([^/]+)/", url_val)
        source = domain.group(1) if domain else ""
        date = published[:10] if published else ""
        entries.append({
            "date": date,
            "source": source,
            "title": title,
            "url": url_val,
            "snippet": snippet[:300],
            "_feed": feed_title,
        })
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", required=True, help="YYYY-MM e.g. 2026-07")
    parser.add_argument("--client", default="sportingtech")
    parser.add_argument("--all", action="store_true",
                        help="Include entries from any date (default: only the given month)")
    args = parser.parse_args()

    period = args.period
    try:
        period_dt = datetime.strptime(period, "%Y-%m")
    except ValueError:
        print("ERROR: --period must be YYYY-MM", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching {len(FEEDS)} Google Alerts feeds for {period}...")
    all_entries = []
    for feed_url in FEEDS:
        entries = fetch_feed(feed_url)
        print(f"  {len(entries):2d} entries — {feed_url.split('/')[-1]}")
        all_entries.extend(entries)

    if not args.all:
        prefix = period  # "2026-07"
        all_entries = [e for e in all_entries if e["date"].startswith(prefix)]

    # Deduplicate by URL
    seen = set()
    deduped = []
    for e in all_entries:
        if e["url"] not in seen:
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
            writer.writerow({k: e[k] for k in ["date", "source", "title", "url", "snippet"]})

    print(f"\n{len(deduped)} mentions written to {out_path}")
    if len(deduped) == 0:
        print("\nNOTE: 0 entries for this period.")
        print("Google Alerts RSS only keeps the most recent ~20 entries per feed.")
        print("For historical months, export from Gmail:")
        print("  Search: from:googlealerts-noreply@google.com")
        print("  Filter by date range, copy titles/URLs into the CSV manually.")


if __name__ == '__main__':
    main()
