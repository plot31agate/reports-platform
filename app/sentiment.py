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


def _mention_hash(mention: dict) -> str:
    raw = "|".join([
        mention.get("url", ""), mention.get("title", ""), mention.get("snippet", ""),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def classify_mentions(
    mentions: List[dict],
    client_config: dict,
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Classify a list of mentions and return aggregate + per-item scores.

    Results are cached per client+content hash, so republish/review loads
    only pay for mentions that haven't been scored before. Failed calls are
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
        content_hash = _mention_hash(m)
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


def synthesise_actions(report_data: dict, client_config: dict) -> dict:
    """Generate 'next month's actions' by passing the assembled report data to Claude."""
    client = _client()
    if not client:
        return {"configured": False, "content": None}

    def _d(key):
        return (report_data.get(key) or {}).get("data")

    summary = json.dumps({
        "coverage": (_d("mentions") or {}).get("total"),
        "sentiment": report_data.get("sentiment", {}),
        "backlinks": _d("ahrefs_backlinks"),
        "traffic": _d("ga4_export"),
        "search_console": _d("search_console"),
        "linkedin": _d("linkedin_company"),
    }, default=str, indent=2)

    prompt = f"""You are a senior PR and growth advisor for {client_config['display_name']}, {client_config.get('sentiment_context', '').split('.')[0]}.

The month's data summary:

{summary}

Give recommended actions for next month, grounded in the data above. Structure:
- Three things to LEAN INTO (double down on wins)
- Two things to INVESTIGATE (interesting signals worth digging into)
- One thing to FIX URGENTLY (biggest risk or gap)

Each item has two parts:
- "action": a short imperative headline, 5 to 10 words maximum, no trailing full stop (e.g. "Feed the proactive earned-media pipeline", "Build a landing page for sportsbook demo"). Never a full sentence with clauses.
- "why": one or two sentences carrying the detail - the specific targets, outlets, queries and numbers from the data that justify it.

Punchy, no fluff, no generic advice. Return as JSON:

{{"lean_into":[{{"action":"...","why":"..."}}],"investigate":[{{"action":"...","why":"..."}}],"fix_urgently":{{"action":"...","why":"..."}}}}"""

    try:
        resp = client.messages.create(
            model=settings.claude_model_synthesis,
            max_tokens=2000,
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
