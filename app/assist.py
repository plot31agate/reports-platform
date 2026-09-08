"""Claude setup assistant — drafts a whole client setup from a short brief.

One call, one JSON draft: given the client's name, website and a one-or-two
line description from the operator, Claude proposes everything the reporting
core wants configured — strategy focus, competitors, executives, the sentiment
brief, the report focus, core keywords, mention queries and which report
sections fit. The operator reviews and edits every field before anything is
saved; this only ever produces a draft.

Reuses the same Anthropic client + model settings as sentiment.py.
"""
import json

from app.config import settings
from app.sentiment import _client
from app.reports.sections import SECTION_DEFS


def draft_client_setup(name: str, website: str = "", description: str = "", kind: str = "reporting") -> dict:
    """Returns {"configured": bool, "draft": dict|None, "error": str|None}.

    draft = {
      about, strategy_focus, competitors[], executives[], sentiment_brief,
      report_focus, core_keywords[], mention_queries[], sections[]
    }
    """
    client = _client()
    if not client:
        return {"configured": False, "draft": None, "error": None}

    section_lines = "\n".join(
        f'- "{d["key"]}": {d["label"]} — {d["hint"]}' for d in SECTION_DEFS if d["key"] != "misc"
    )

    prompt = f"""You are setting up a new client for a digital marketing agency's reporting system.

Client name: "{name}"
Website: {website or "not provided"}
Setup type: {"Client HQ (full content + portal client)" if kind == "client-hq" else "Reporting client"}
What the operator says about them: {description or "nothing yet - infer carefully from the name and website"}

Draft the client's full reporting setup. If you recognise the company, use what you know; where you are unsure, make sensible, clearly-generic proposals the operator can correct rather than invented specifics (never fabricate a named person you are not confident about - an empty executives list is better than a wrong one).

Return ONLY valid JSON, no prose, no markdown fences, matching exactly:
{{
  "about": "one or two sentences: what the company does and who its customers are",
  "strategy_focus": "one line on a sensible strategic focus for their digital/search presence",
  "competitors": ["competitor brand names, 3-6, only if plausibly real"],
  "executives": ["named executives worth tracking in media coverage, only if confident, else empty"],
  "sentiment_brief": "a 120-200 word sentiment-scoring brief: one sentence on the company, then 'Score sentiment from {name}'s commercial perspective:' followed by short POSITIVE / NEGATIVE / NEUTRAL guidance naming the concrete story types for this business, ending with any counter-intuitive cases. Plain text, no markdown, plain hyphens and commas, never em dashes",
  "report_focus": "an 80-140 word editorial-focus brief: one sentence on the report's primary purpose, then 'Lead with:' the metrics that carry the headline, 'Support with:' the context areas, and one sentence on the voice. Plain text, no markdown, plain hyphens and commas, never em dashes",
  "core_keywords": ["5-10 non-branded search keywords this client should be judged on"],
  "mention_queries": ["2-5 news search phrases: the brand name, product names, key executives"],
  "sections": ["report section keys that fit this client, from the list below"]
}}

Available report sections (return only their keys):
{section_lines}"""

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
        draft = json.loads(raw.strip())
        # Only keep known section keys, in canonical order.
        valid = [d["key"] for d in SECTION_DEFS]
        picked = draft.get("sections") if isinstance(draft.get("sections"), list) else []
        draft["sections"] = [k for k in valid if k in picked]
        return {"configured": True, "draft": draft, "error": None}
    except Exception as e:
        return {"configured": True, "draft": None, "error": str(e)}
