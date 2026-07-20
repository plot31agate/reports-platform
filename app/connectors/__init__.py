"""API connectors — pull source data directly instead of CSV uploads.

Credentials split two ways:
  - Agency keys (one per provider, shared by every client): the Ahrefs API
    key, the Similarweb API key, the Google service account JSON.
  - Client settings (per client): which domain / GA4 property / Search
    Console site to pull for that client.

Each connector fetches from the provider's API and writes a CSV in the exact
format the matching ingestion parser already understands, into the same
data/{client}/{period}/ folder an upload would land in. Everything downstream
(checklist, build, report) is identical for synced and uploaded data.
"""
from app.connectors import ahrefs, google, meta, serper


# Drives the Agency API keys page, the per-client workspace panel, and the
# workspace Sync buttons. Field types: 'text' | 'password' | 'textarea'.
# Secret fields are write-only in the UI — blank on save keeps the stored value.
CONNECTOR_DEFS = [
    {
        "provider": "ahrefs",
        "label": "Ahrefs",
        "sources": ["ahrefs_backlinks", "ahrefs_trends", "competitor_benchmark", "technical_seo_metrics", "search_console"],
        # Which client fields each source needs before it can sync.
        "requires": {
            "ahrefs_backlinks": ["target"],
            "ahrefs_trends": ["target"],
            "competitor_benchmark": ["target"],
            "technical_seo_metrics": [("audit_project_id", "gsc_project_id"), "target"],
            "search_console": [("audit_project_id", "gsc_project_id")],
        },
        "blurb": "Pulls backlinks, 12-month authority trends, technical SEO metrics (Site Audit), the competitor benchmark, and — when the client's Search Console is connected to the Ahrefs project — search data too. The curated issue register stays a manual upload.",
        "agency_fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True},
        ],
        "client_fields": [
            {"key": "target", "label": "Target domain", "type": "text",
             "placeholder": "example.com"},
            # One ID covers the whole Ahrefs project: Site Audit, GSC
            # Insights, and the Rank Tracker competitor list all live under
            # the same project_id (the number in any Ahrefs project URL).
            {"key": "audit_project_id", "label": "Ahrefs project ID", "type": "text",
             "placeholder": "e.g. 123456",
             "hint": "The number in the project's Ahrefs URL, e.g. app.ahrefs.com/site-audit/<id>. Feeds technical SEO, Search Console (GSC Insights - free API calls, needs the client's GSC connected to the project), and the project's competitor list."},
            {"key": "competitor_domains", "label": "Competitor domains", "type": "text",
             "placeholder": "betconstruct.com, altenar.com, kambi.com",
             "hint": "Optional - leave blank to pull the competitor list straight from the Ahrefs project. Fill in to override. Brand names come from the client's competitor list automatically."},
        ],
        "key_help": [
            "Log in to Ahrefs on the agency account",
            "Account settings → API keys",
            "Click \"Generate API key\" (the API key, not the MCP key — that one is for AI assistants)",
            "Copy the key and paste it here. Note: API v3 access needs an Enterprise plan or the API add-on — a 403 on test means plan, not key",
        ],
    },
    # Similarweb was retired in favour of GA4 geography: real measured
    # country data from an account we already have, instead of paying for
    # panel estimates. The connector module remains if it's ever wanted back.
    {
        "provider": "google",
        "label": "Google — GA4 & Search Console",
        "sources": ["ga4_export", "ga4_geography", "search_console"],
        "requires": {
            "ga4_export": ["ga4_property_id"],
            "ga4_geography": ["ga4_property_id"],
            "search_console": ["gsc_site_url"],
        },
        "blurb": "One service account covers GA4 traffic, GA4 geography, and Search Console for every client. Search Console pulls straight from Google — no Ahrefs project needed; set the property below and it takes over from the Ahrefs GSC Insights route.",
        "agency_fields": [
            {"key": "service_account_json", "label": "Service account JSON", "type": "textarea", "secret": True},
        ],
        "client_fields": [
            {"key": "ga4_property_id", "label": "GA4 property ID", "type": "text",
             "placeholder": "123456789", "hint": "GA4 → Admin → Property settings (numbers only)"},
            {"key": "gsc_site_url", "label": "Search Console property", "type": "text",
             "placeholder": "example.com or https://www.example.com/",
             "hint": "A bare domain means the domain property (sc-domain:). Paste the full URL only for URL-prefix properties. Needs the service account email added as a user in Search Console → Settings → Users and permissions. Leave blank if this client's search data comes via Ahrefs GSC Insights."},
        ],
        "key_help": [
            "Go to console.cloud.google.com → create (or pick) a project",
            "APIs & Services → Enable APIs → enable \"Google Analytics Data API\" and \"Google Search Console API\"",
            "IAM & Admin → Service accounts → Create service account (any name, no roles needed)",
            "Open the account → Keys → Add key → Create new key → JSON — a file downloads",
            "Paste the whole JSON file here",
            "Then grant it access per client: in GA4 → Admin → Property access management → add the service account's email as Viewer",
            "And for Search Console: Settings → Users and permissions → Add user → the service account's email (Full or Restricted both work)",
        ],
    },
    {
        "provider": "meta",
        "label": "Meta — Facebook & Instagram",
        "sources": ["meta_social"],
        # At least the FB Page ID; the IG account is optional and pulled too
        # when its ID is set. (pick_provider needs an all-required list, so the
        # page is the gate - IG-only clients can still upload the CSV.)
        "requires": {
            "meta_social": ["fb_page_id"],
        },
        "blurb": "Pulls Facebook Page and Instagram daily insights - views, reach, content interactions, link clicks and new followers - into one social CSV. The agency token covers every client whose pages sit in that Meta business portfolio; a client on a separate portfolio can paste its own token override below.",
        "agency_fields": [
            {"key": "access_token", "label": "Access token", "type": "password", "secret": True},
        ],
        "client_fields": [
            {"key": "fb_page_id", "label": "Facebook Page ID", "type": "text",
             "placeholder": "e.g. 1234567890",
             "hint": "Easiest way: leave this as-is, save, and click Test - it lists the exact Page ID (and the linked Instagram ID) this token can read, ready to copy. Manual: Business Suite → Settings → the Page shows its numeric ID. Note the number in the page's web address is a profile ID, not the Page ID, so don't use that."},
            {"key": "ig_user_id", "label": "Instagram account ID", "type": "text",
             "placeholder": "optional, e.g. 17841400000000000",
             "hint": "Optional - Facebook-only clients leave blank. The IG account must be a Business/Creator account linked to the Facebook Page above; once it is, Test lists its numeric ID right next to the Page. You can't get one without the other - they come from the same linked Page."},
            {"key": "client_access_token", "label": "Access token override", "type": "password", "secret": True,
             "hint": "Only if this client's Page lives in a different Meta business portfolio than the agency token. Generate a System User token in that portfolio and paste it here. Leave blank to use the shared agency token."},
        ],
        "key_help": [
            "In Meta Business Suite, the page and its Instagram account must be in a Business portfolio (Business Settings → Accounts)",
            "Business Settings → Users → System Users → Add (or pick) a system user, give it access to the pages you report on",
            "With the system user selected → Generate new token → choose your app → tick permissions: pages_read_engagement, read_insights, instagram_basic, instagram_manage_insights",
            "Set the token to never expire if offered, copy it, and paste it here",
            "Then per client, set the Facebook Page ID (and Instagram account ID if used) on their Meta card in the workspace",
        ],
    },
    {
        "provider": "serper",
        "label": "Serper — Google News mentions",
        "sources": ["mentions"],
        # A client can sync once it has an agency key; queries fall back to the
        # client's brand name + executives, so no per-client field is strictly
        # required to light the Sync button.
        "requires": {
            "mentions": [],
        },
        "blurb": "Pulls media mentions from Google News by search query - the brand name plus executive and product names - and writes the same mentions CSV as Google Alerts. One API key covers every client. RSS Auto-fetch and manual upload still work as alternatives.",
        "agency_fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True},
        ],
        "client_fields": [
            {"key": "mention_queries", "label": "Search queries", "type": "textarea",
             "placeholder": "One phrase per line, e.g.\nMindway AI\n\"GameScanner\"\nRasmus Kjaergaard",
             "hint": "One search phrase per line - brand, product and executive names. Wrap exact phrases in quotes. Leave blank to use the client's brand name and tracked executives automatically."},
        ],
        "key_help": [
            "Go to serper.dev and sign up (2,500 free searches, then pay as you go)",
            "Open the Dashboard - your API key is shown at the top",
            "Copy the key and paste it here",
            "Serper bills per search; each client sync runs one search per configured query",
        ],
    },
]

_MODULES = {"ahrefs": ahrefs, "google": google, "meta": meta, "serper": serper}

# source_key -> providers that can feed it, in preference order (defs order).
SOURCE_PROVIDERS: dict = {}
for _d in CONNECTOR_DEFS:
    for _src in _d["sources"]:
        SOURCE_PROVIDERS.setdefault(_src, []).append(_d["provider"])

# search_console has two routes: direct from Google, or Ahrefs GSC Insights.
# Prefer Google when its site URL is set — it's the primary source and an
# explicit opt-in, and it stops a client whose Ahrefs project merely exists
# (for Site Audit) but has no GSC linked from shadowing the working route.
SOURCE_PROVIDERS["search_console"] = ["google", "ahrefs"]


def pick_providers(source_key: str, agency_creds: dict, client_configs: dict) -> list:
    """Every provider that could feed this source, in preference order.

    A source can have more than one route (search_console: Google direct, or
    Ahrefs GSC Insights). The caller syncs the first and falls back down the
    list if it errors, so a misconfigured preferred route doesn't take the
    source offline when a working one exists.

    A required field given as a tuple means "any of these" — the Ahrefs
    project ID is stored as gsc_project_id on configs saved before the two
    project-ID fields were merged, and the sync path still honours both.

    agency_creds: {provider: row} (from get_agency_credentials)
    client_configs: {provider: parsed client config dict}
    """
    out = []
    for provider in SOURCE_PROVIDERS.get(source_key, []):
        if provider not in agency_creds:
            continue
        cfg = client_configs.get(provider) or {}
        required = get_def(provider).get("requires", {}).get(source_key, [])
        if all(
            any((cfg.get(k) or "").strip() for k in (req if isinstance(req, tuple) else (req,)))
            for req in required
        ):
            out.append(provider)
    return out


def pick_provider(source_key: str, agency_creds: dict, client_configs: dict):
    """The preferred provider for a source, or None if nothing is configured."""
    providers = pick_providers(source_key, agency_creds, client_configs)
    return providers[0] if providers else None


def get_def(provider: str) -> dict:
    for d in CONNECTOR_DEFS:
        if d["provider"] == provider:
            return d
    raise KeyError(f"Unknown connector: {provider}")


def agency_secret_keys(provider: str) -> list:
    return [f["key"] for f in get_def(provider).get("agency_fields", [])]


def test_key(provider: str, agency_config: dict) -> tuple[bool, str]:
    """Validate the agency-level key alone (no client settings needed)."""
    return _MODULES[provider].test_key(agency_config)


def test_connection(provider: str, config: dict) -> tuple[bool, str]:
    """Full round-trip using merged agency + client config."""
    return _MODULES[provider].test(config)


def sync_source(provider: str, config: dict, source_key: str, dest, period: str):
    """Fetch one source for the period and write its CSV to dest (a Path)."""
    return _MODULES[provider].sync(config, source_key, dest, period)
