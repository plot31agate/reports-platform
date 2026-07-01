"""Sentiment classification and next-month synthesis via the Claude API.

Two entry points:
- classify_mentions(mentions, client_config): scores each mention pos/neg/neutral
- synthesise_actions(report_data, client_config): generates the "next month" section
"""
import json
from typing import List, Optional

from anthropic import Anthropic

from app.config import settings


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
            "classification": data.get("classification", "neutral"),
            "confidence": float(data.get("confidence", 0.5)),
            "themes": data.get("themes", []),
            "rationale": data.get("rationale", ""),
        }
    except Exception as e:
        return {
            "classification": "neutral",
            "confidence": 0.0,
            "themes": [],
            "rationale": f"(classification failed: {e})",
        }


def classify_mentions(mentions: List[dict], client_config: dict) -> dict:
    """Classify a list of mentions and return aggregate + per-item scores."""
    client = _client()
    if not client or not mentions:
        return {
            "configured": bool(client),
            "total": len(mentions),
            "positive": 0, "neutral": 0, "negative": 0,
            "avg_score": None,
            "scored": [],
        }

    scored = []
    for m in mentions:
        result = classify_mention(client, m, client_config)
        scored.append({**m, **result})

    pos = sum(1 for s in scored if s["classification"] == "positive")
    neg = sum(1 for s in scored if s["classification"] == "negative")
    neu = sum(1 for s in scored if s["classification"] == "neutral")

    # Simple sentiment score: (pos - neg) / total, range -1 to +1
    avg_score = round((pos - neg) / len(scored), 2) if scored else None

    return {
        "configured": True,
        "total": len(scored),
        "positive": pos, "neutral": neu, "negative": neg,
        "avg_score": avg_score,
        "scored": scored,
    }


def synthesise_actions(report_data: dict, client_config: dict) -> dict:
    """Generate 'next month's actions' by passing the assembled report data to Claude."""
    client = _client()
    if not client:
        return {"configured": False, "content": None}

    summary = json.dumps({
        "coverage": report_data.get("mentions", {}).get("data", {}).get("total"),
        "sentiment": report_data.get("sentiment", {}),
        "backlinks": report_data.get("ahrefs_backlinks", {}).get("data"),
        "traffic": report_data.get("ga4_export", {}).get("data"),
        "search_console": report_data.get("search_console", {}).get("data"),
        "linkedin": report_data.get("linkedin_company", {}).get("data"),
    }, default=str, indent=2)

    prompt = f"""You are a senior PR and growth advisor for {client_config['display_name']}, {client_config.get('sentiment_context', '').split('.')[0]}.

The month's data summary:

{summary}

Give recommended actions for next month, grounded in the data above. Structure:
- Three things to LEAN INTO (double down on wins)
- Two things to INVESTIGATE (interesting signals worth digging into)
- One thing to FIX URGENTLY (biggest risk or gap)

Each item: one clear sentence of recommendation + one sentence of reasoning citing specific numbers from the data. Punchy, no fluff, no generic advice. Return as JSON:

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
