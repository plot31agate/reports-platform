"""Sentiment classification and next-month synthesis via the Claude API.

Two entry points:
- classify_mentions(mentions, client_config): scores each mention pos/neg/neutral
- synthesise_actions(report_data, client_config): generates the "next month" section
"""
import hashlib
import json
from typing import Callable, List, Optional

from anthropic import Anthropic

from app.config import settings
from app.db import get_sentiment_cached, put_sentiment_cache


def _client() -> Optional[Anthropic]:
    if not settings.anthropic_api_key:
        return None
    return Anthropic(api_key=settings.anthropic_api_key)


SENTIMENT_SCHEMA = """Return ONLY valid JSON matching this exact schema — no prose, no markdown fences:
{"classification":"positive|neutral|negative","confidence":0.0-1.0,"themes":["theme1","theme2"],"rationale":"one sentence"}"""


def classify_mention(client, mention: dict, client_config: dict) -> dict:
    """Classify a single mention. Returns dict with classification, confidence, themes, rationale."""
    text = f"Headline: {mention.get('title', '')}\nSource: {mention.get('source', '')}\nSnippet: {mention.get('snippet', '')}"

    prompt = f"""{client_config['sentiment_context']}

Classify the following mention:

{text}

{SENTIMENT_SCHEMA}"""

    try:
        resp = client.messages.create(
            model=settings.claude_model_sentiment,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        # Strip any accidental fences
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = json.loads(raw.strip())
        return {
            "ok": True,
            "classification": data.get("classification", "neutral"),
            "confidence": float(data.get("confidence", 0.5)),
            "themes": data.get("themes", []),
            "rationale": data.get("rationale", ""),
        }
    except Exception as e:
        return {
            "ok": False,
            "classification": "neutral",
            "confidence": 0.0,
            "themes": [],
            "rationale": f"(classification failed: {e})",
        }


def _mention_hash(mention: dict, client_config: dict) -> str:
    """Key a cached classification to the exact inputs that produced it.

    The brief and the model are part of the key, not just the mention text:
    an operator who rewrites the brief expects the next build to re-score
    everything under it, and a cache keyed on content alone would replay the
    old brief's calls forever.
    """
    raw = "|".join([
        mention.get("url", ""), mention.get("title", ""), mention.get("snippet", ""),
        (client_config.get("sentiment_context") or "").strip(),
        settings.claude_model_sentiment,
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def classify_mentions(
    mentions: List[dict],
    client_config: dict,
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Classify a list of mentions and return aggregate + per-item scores.

    Results are cached per client + mention content + brief + model, so
    republish/review loads only pay for mentions that haven't been scored
    before, and editing the brief re-scores the lot. Failed calls are
    never cached, are excluded from the sentiment score, and are counted in
    `failed` so the UI can flag a degraded build instead of passing failures
    off as neutral coverage.
    """
    client = _client()
    slug = client_config.get("slug", "")
    if not client or not mentions:
        return {
            "configured": bool(client),
            "total": len(mentions),
            "positive": 0, "neutral": 0, "negative": 0,
            "avg_score": None,
            "scored": [],
            "failed": 0,
            "from_cache": 0,
        }

    scored = []
    failed = 0
    from_cache = 0
    for i, m in enumerate(mentions):
        content_hash = _mention_hash(m, client_config)
        result = get_sentiment_cached(slug, content_hash)
        if result:
            from_cache += 1
        else:
            result = classify_mention(client, m, client_config)
            if result.get("ok"):
                put_sentiment_cache(slug, content_hash, result)
            else:
                failed += 1
        scored.append({**m, **result})
        if progress:
            progress(i + 1, len(mentions))

    counted = [s for s in scored if s.get("ok", True)]
    pos = sum(1 for s in counted if s["classification"] == "positive")
    neg = sum(1 for s in counted if s["classification"] == "negative")
    neu = sum(1 for s in counted if s["classification"] == "neutral")

    # Simple sentiment score: (pos - neg) / classified, range -1 to +1.
    avg_score = round((pos - neg) / len(counted), 2) if counted else None

    return {
        "configured": True,
        "total": len(scored),
        "positive": pos, "neutral": neu, "negative": neg,
        "avg_score": avg_score,
        "scored": scored,
        "failed": failed,
        "from_cache": from_cache,
    }


def draft_sentiment_brief(display_name: str, description: str, competitors: list | None = None) -> dict:
    """Write a per-client sentiment brief from a one-line description.

    Returns {"configured": bool, "brief": str|None, "error": str|None}.
    The brief is the context classify_mention scores each mention against,
    so an operator never has to hand-write the pos/neg/neutral rules.
    """
    client = _client()
    if not client:
        return {"configured": False, "brief": None, "error": None}

    comp = ", ".join(competitors) if competitors else "none provided"
    prompt = f"""Write a sentiment-scoring brief for media monitoring of a company called "{display_name}".

What the company does (from the operator): {description or "not specified"}
Known competitors: {comp}

The brief is read by an AI that scores each news mention of the company as POSITIVE, NEGATIVE or NEUTRAL from the company's own commercial perspective. Write instructions that make those calls correctly for THIS company, including any cases where the obvious reading is wrong (for example, a company whose product addresses a problem may benefit commercially when coverage of that problem increases).

Structure the brief as:
- One sentence naming the company, what it does, and who its customers are.
- "Score sentiment from {display_name}'s commercial perspective:" then three short paragraphs or bullet groups for POSITIVE, NEGATIVE and NEUTRAL, each naming the concrete kinds of story that belong there for this specific business.
- A final sentence on any counter-intuitive cases worth getting right.

Write only the brief itself, no preamble, no headings, no markdown. 120-200 words. Use plain hyphens and commas, never em dashes."""

    try:
        resp = client.messages.create(
            model=settings.claude_model_synthesis,
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        return {"configured": True, "brief": resp.content[0].text.strip(), "error": None}
    except Exception as e:
        return {"configured": True, "brief": None, "error": str(e)}


def draft_report_focus(display_name: str, description: str, section_labels: list | None = None) -> dict:
    """Write a per-client report-focus brief from a one-line description.

    Returns {"configured": bool, "brief": str|None, "error": str|None}.
    The brief steers the editorial voice of the whole report - which metrics
    lead the story and which are supporting cast - so a PR-led client reads
    differently from a growth/social-led one.
    """
    client = _client()
    if not client:
        return {"configured": False, "brief": None, "error": None}

    sections = ", ".join(section_labels) if section_labels else "not specified"
    prompt = f"""Write an editorial-focus brief for the monthly performance report of a company called "{display_name}".

What the report should focus on (from the operator): {description or "not specified"}
Report sections enabled for this client: {sections}

The brief is read by an AI that writes the report's headline, executive summary and section commentary from a month of PR, search, traffic and social data. Write instructions that tell it what kind of report this is for THIS client - which areas lead the story and which are supporting detail.

Structure the brief as:
- One sentence naming the report's primary purpose (e.g. earned-media and PR impact, or audience growth and social reach, or organic search performance).
- "Lead with:" one or two sentences naming the metrics and stories that should open the report and carry the headline.
- "Support with:" one sentence on the areas that appear as context but should not dominate.
- One sentence on the voice (e.g. written for a comms director who cares about outlet quality, or for a marketing lead who cares about follower and traffic growth).

Write only the brief itself, no preamble, no headings, no markdown. 80-140 words. Use plain hyphens and commas, never em dashes."""

    try:
        resp = client.messages.create(
            model=settings.claude_model_synthesis,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        return {"configured": True, "brief": resp.content[0].text.strip(), "error": None}
    except Exception as e:
        return {"configured": True, "brief": None, "error": str(e)}


def synthesise_actions(report_data: dict, client_config: dict) -> dict:
    """Generate 'next month's actions' by passing the assembled report data to Claude."""
    client = _client()
    if not client:
        return {"configured": False, "content": None}

    def _d(key):
        return (report_data.get(key) or {}).get("data")

    summary = json.dumps({
        "coverage": (_d("mentions") or {}).get("total"),
        "mentions": [
            {"title": m.get("title"), "source": m.get("source")}
            for m in ((_d("mentions") or {}).get("mentions") or [])[:12]
        ],
        "sentiment": report_data.get("sentiment", {}),
        "backlinks": _d("ahrefs_backlinks"),
        # Levels and changes, labelled as such. Handing over the delta dict
        # alone got the change written up as the metric itself ("a domain
        # rating of 3.0" for a domain rating of 60 that rose 3 points).
        "authority": {
            "latest": (_d("ahrefs_trends") or {}).get("latest"),
            "change_vs_last_month": (_d("ahrefs_trends") or {}).get("deltas"),
            "change_since": {
                "from_month": (_d("ahrefs_trends") or {}).get("span_from"),
                "change": (_d("ahrefs_trends") or {}).get("span_deltas"),
            },
        } if _d("ahrefs_trends") else None,
        "core_keywords": _d("core_keywords"),
        "competitor_benchmark": _d("competitor_benchmark"),
        "traffic": _d("ga4_export"),
        "daily_traffic": _d("ga4_daily"),
        "geography": _d("ga4_geography"),
        "search_console": _d("search_console"),
        "linkedin": _d("linkedin_company"),
        "facebook_instagram": _d("meta_social"),
        "tiktok": _d("tiktok"),
        "influencers": _d("influencer_activity"),
        "technical_seo": _d("technical_seo_metrics"),
    }, default=str, indent=2)

    # Per-client editorial steer: the operator-written focus brief decides
    # which areas lead the story; the enabled-sections list is the fallback
    # signal when no brief is set (a social-only client should never get a
    # PR-led intro just because the generic prompt weighs coverage first).
    from app.reports.sections import SECTION_DEFS, enabled_sections
    section_labels = {d["key"]: d["label"] for d in SECTION_DEFS}
    enabled = [section_labels[k] for k in enabled_sections(client_config) if k in section_labels]

    # At-a-glance rows the rules flagged amber/red: the AI drafts each one's
    # "next" line - the reassuring what-we're-doing-about-it under the dot.
    flagged = [r for r in (report_data.get("glance_rows") or []) if r.get("status") in ("amber", "red")]
    if flagged:
        flag_lines = "\n".join(
            f'- "{r["key"]}": {r["area"]} - {r["headline"]} (flagged {r["status"]})'
            for r in flagged
        )
        glance_block = f"""

The report opens with a traffic-light status strip, and these rows are flagged this month:
{flag_lines}

For each flagged row, also return under "glance" (keyed by the quoted row key) one line of 12 words maximum saying what is being done about it next month. It must be specific and grounded in the recommended actions, never generic reassurance - e.g. "Rebuilding visibility in the three highest-volume markets" not "We are monitoring this closely"."""
        glance_schema = ',"glance":{"' + flagged[0]["key"] + '":"..."}'
    else:
        glance_block = ""
        glance_schema = ""

    focus_brief = (client_config.get("report_focus") or "").strip()
    if focus_brief:
        focus_block = f"""Editorial focus for this client's report:
{focus_brief}

This focus decides the report's emphasis: the headline, standfirst, intro and the ordering of ideas inside every note must lead with the areas it names as primary, and treat the rest as supporting context. Recommended actions should also skew toward the primary areas.

This holds even when another area has the month's most dramatic numbers. A big coverage month for a traffic-led report is a supporting paragraph, never the headline. If the primary area's data is thin or flat, lead with it anyway and say so honestly - a quiet month in the focus area IS the story, and the louder area still goes below it."""
    else:
        focus_block = f"""This client's report covers these sections: {", ".join(enabled) if enabled else "the default set"}. Weight the headline, standfirst and intro toward the areas where this month's data shows the most meaningful movement, and do not dwell on areas outside the enabled sections."""

    prompt = f"""You are a senior PR and growth advisor for {client_config['display_name']}, {client_config.get('sentiment_context', '').split('.')[0]}.

{focus_block}

Voice and tone - this report is written by the client's agency, in the agency's voice, to the client's leadership. It presents OUR work on THEIR brand, so it reads like a trusted partner walking them through the month, never like a critic reviewing someone else's numbers:

- Warm, confident and constructive throughout. The default register is "here's where we are and here's what we're doing", not "here's what went wrong".
- Honest about declines, never gloomy or wry about them: state the number plainly, name the likely driver, and point at what happens next. A drop is a finding with a plan attached, not a verdict.
- Never sarcastic, ironic or deadpan. No faint praise ("a rare bright spot", "at least engagement held"), no melodrama ("collapsed", "plummeted", "dismal", "worrying decline"), no rhetorical shrugs. Use plain movement words: rose, fell, eased, held, dropped 12%.
- Give wins their full weight. When the month has genuine wins, let them sound like wins - understating them reads as sourness.
- Blame nothing and no one. Never imply the client, their site, their content or past work is at fault; frame gaps as the next opportunity to work on together.

This tone holds everywhere - headline, standfirst, every note, every action, every watch item - and it holds even in a flat or difficult month. A hard month written well sounds steady and in-hand, not bleak.

The month's data summary:

{summary}

Give recommended actions for next month, grounded in the data above. Structure:
- Three things to LEAN INTO (double down on wins)
- Two things to INVESTIGATE (interesting signals worth digging into)
- One thing to FIX URGENTLY (biggest risk or gap)

Each item has two parts:
- "action": a short imperative headline, 5 to 10 words maximum, no trailing full stop (e.g. "Feed the proactive earned-media pipeline", "Build a landing page for sportsbook demo"). Never a full sentence with clauses.
- "why": one or two sentences carrying the detail - the specific targets, outlets, queries and numbers from the data that justify it.

Also give a read on the month:
- "worked": three to five bullets on what worked, each a single string of one or two sentences naming the specific result and the numbers behind it
- "watch": two to four bullets on what to watch, each a single string of one or two sentences naming a soft spot, risk or caveat in the data - phrased as something we are keeping an eye on and how, not as a warning

Also write the report's editorial framing. This is the part the client's leadership actually reads: it must tell the story of the month, not recite numbers. Every piece should say what happened, what drove it, and what it means for the client - the numbers support the sentence, they never lead it.

- "headline": the report title, 4 to 8 words naming the month's defining story in the report's primary focus area (e.g. "Kenya launch drives record coverage" for a PR-led report, "Follower growth accelerates across every channel" for a social-led one). Title case only on the first word and proper nouns, no trailing full stop, no colons.
- "standfirst": one or two sentences under the headline framing the month's story - the defining development and its strongest number.
- "notes": an object of section commentaries keyed as below. ALWAYS include "intro". Include the other keys only when the summary above has data for them.
  - "intro": the overriding commentary, three to four sentences. Open with the single defining development of the month in the report's primary focus area, connect the threads (how the other areas relate to it this month), and close with where the focus goes next. This is the executive summary at the top of the report.
  - "media" (coverage), "sentiment", "sov" (competitor share of voice), "execs" (executives in coverage), "traffic" (search and site traffic, including core keyword positions and what moved into or out of the top five), "trends" (the day-by-day pattern from daily_traffic - name the spike days, what likely drove them, and how the shape compares to last month), "campaigns" (visitor geography), "backlinks" (domain authority and links), "linkedin", "social" (Facebook and Instagram), "tiktok", "influencers" (creator partnerships), "technical_seo": one or two sentences each that continue the month's story through that lens - what happened in this area, what drove it, and what it means. Name the specific outlets, queries, countries or numbers that matter.
{glance_block}
Specific, concise, no fluff, no generic advice - and always in the voice described above. Use plain hyphens and commas for punctuation, never em dashes. Return as JSON:

{{"headline":"...","standfirst":"...","notes":{{"intro":"...","media":"..."}},"lean_into":[{{"action":"...","why":"..."}}],"investigate":[{{"action":"...","why":"..."}}],"fix_urgently":{{"action":"...","why":"..."}},"worked":["..."],"watch":["..."]{glance_schema}}}"""

    try:
        resp = client.messages.create(
            model=settings.claude_model_synthesis,
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = json.loads(raw.strip())
        return {"configured": True, "content": data}
    except Exception as e:
        return {"configured": True, "content": None, "error": str(e)}
