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


def _slugify(name: str) -> str:
    import re
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or "client"


# The facts and secrets the client-hq intake needs that Claude must NOT invent —
# they come from the operator (several already live in the per-client vault).
# The drafter lists these in the pack's `operator_required` so the runner and UI
# know a live deploy is blocked until they're supplied.
OPERATOR_REQUIRED = [
    "Timezone (confirm the drafted guess)",
    "cPanel host + account, and the absolute home dir (e.g. /home/acct) — for the AuthUserFile path",
    "Scoped FTP/FTPS deploy account (never the master account)",
    "Basic Auth username + password for the estate (one realm across portal + builder)",
    "Buffer account + access token (if the Social/Buffer room ships)",
    "Anthropic API key (agency key or a per-client key)",
    "GA4 property + measurement id, and Search Console verification (for Site Health)",
]


def draft_hq_build_pack(name: str, website: str = "", description: str = "",
                        owner: str = "Unassigned") -> dict:
    """Draft the client-hq intake for a client, aligned to references/intake.md
    (phases A-H), so the pack can STAND IN FOR the interactive interview when the
    runner builds unattended. Returns {"configured","pack","error"}.

    This is the "Claude element" behind Create-HQ. It drafts only what can be
    sensibly inferred; credentials and hosting facts it cannot know are left for
    the operator and named in pack["operator_required"] (many live in the vault).
    The runner (scripts/hq_builder.py) writes the pack to CLIENT.md and hands it
    to the client-hq skill, which clones plot31agate/aerahouse and re-points it.
    """
    slug = _slugify(name)
    client = _client()
    if not client:
        return {"configured": False, "pack": None, "error": None}

    prompt = f"""You are drafting the intake for a new client's "Client HQ" — the Aera-style
ecosystem the client-hq skill builds: a client website (PHP/static, push-to-live
FTPS deploy), a branded social/card studio, and a Digital Footprints client
portal (content engine, month planner, post workbench + Buffer, plan-approval
share links, site health, reports). The skill clones a proven reference repo and
re-points it; your job is to answer its intake so it can build WITHOUT stopping
to interview a human.

Client name: "{name}"
Website (existing site, or blank if none yet): {website or "not provided"}
Account owner at the agency: {owner}
What the operator says: {description or "nothing yet - infer carefully from the name and website"}

Draft sensible, clearly-correctable answers. NEVER invent credentials, API keys,
FTP/cPanel details, GA4 ids, or a named person you aren't confident about — those
are the operator's to supply. Return ONLY valid JSON, no prose, no markdown
fences, matching exactly (intake phase letters shown for reference):
{{
  "client": {{                                        // A
    "wordmark": "exact brand name casing",
    "domain": "apex domain without protocol, or empty if none yet",
    "brief": "one paragraph: what they sell, to whom, what makes them different",
    "timezone_guess": "IANA tz you infer, e.g. Europe/London (operator confirms)"
  }},
  "site": {{                                           // B
    "exists": true,
    "kind": "one of: php-static | wordpress | other-cms | none-yet",
    "register_driven_content": true,
    "pages": ["marketing site pages, e.g. Home, About, Services, Contact"],
    "primary_cta": "main visitor action, e.g. 'Book a consultation'",
    "same_account": true
  }},
  "rooms": {{                                          // C — each: "yes" | "no" | "later"
    "content_engine": "yes", "social_builder": "yes", "buffer": "yes",
    "month_planner": "yes", "plan_approvals": "yes", "site_health": "yes", "reports": "later"
  }},
  "brand": {{                                          // E (client OUTPUT brand)
    "primary_color": "#RRGGBB suited to the sector",
    "accent_color": "#RRGGBB complement",
    "tone_adjectives": ["three tone words"],
    "person": "we | you",
    "english_variant": "e.g. British English",
    "hard_rules": "any hard rule, e.g. 'no em-dashes', or empty",
    "tagline": "short plausible tagline or empty"
  }},
  "audience": "who reads this and what they care about",   // E
  "no_gos": ["topics/claims/words to never use"],          // E
  "channels": ["social channels: Instagram, Facebook, LinkedIn"],  // F
  "cadence": {{"articles_per_month": 4, "posts_per_week": 3, "reels_per_month": 0}},  // F
  "posting_time": "HH:MM client-time (confirm)",           // F
  "content_strands": ["up to ~12 named content themes"],    // F
  "reporting": {{"on_platform": true, "headline_numbers": ["three monthly numbers that matter"]}},  // H
  "hosting": {{"repo_name": "{slug}", "owner": "plot31agate", "domain": "apex domain or empty",
              "notes": "one line for the build agent, or empty"}}
}}"""

    try:
        resp = client.messages.create(
            model=settings.claude_model_synthesis,
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        pack = json.loads(raw.strip())
        # Stamp identity + the operator checklist the model must not fabricate.
        pack["name"] = name
        pack["slug"] = slug
        pack["owner"] = owner
        pack.setdefault("hosting", {})
        pack["hosting"].setdefault("repo_name", slug)
        pack["hosting"].setdefault("owner", "plot31agate")
        pack["operator_required"] = OPERATOR_REQUIRED
        return {"configured": True, "pack": pack, "error": None}
    except Exception as e:
        return {"configured": True, "pack": None, "error": str(e)}
