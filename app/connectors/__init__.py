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
from app.connectors import ahrefs, similarweb, google


# Drives the Agency API keys page, the per-client workspace panel, and the
# workspace Sync buttons. Field types: 'text' | 'password' | 'textarea'.
# Secret fields are write-only in the UI — blank on save keeps the stored value.
CONNECTOR_DEFS = [
    {
        "provider": "ahrefs",
        "label": "Ahrefs",
        "sources": ["ahrefs_backlinks"],
        "blurb": "Pulls the live backlink profile — replaces the ahrefs_backlinks CSV export.",
        "agency_fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True},
        ],
        "client_fields": [
            {"key": "target", "label": "Target domain", "type": "text",
             "placeholder": "example.com"},
        ],
        "key_help": [
            "Log in to Ahrefs on the agency account",
            "Account settings → API keys",
            "Click \"Generate API key\" (the API key, not the MCP key — that one is for AI assistants)",
            "Copy the key and paste it here. Note: API v3 access needs an Enterprise plan or the API add-on — a 403 on test means plan, not key",
        ],
    },
    {
        "provider": "similarweb",
        "label": "Similarweb",
        "sources": ["similarweb_traffic"],
        "blurb": "Pulls monthly visits — replaces the similarweb_traffic CSV export.",
        "agency_fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True},
        ],
        "client_fields": [
            {"key": "domain", "label": "Domain", "type": "text",
             "placeholder": "example.com"},
        ],
        "key_help": [
            "Log in to Similarweb on the agency account",
            "Account (avatar menu) → API management",
            "Create or copy an API key and paste it here",
            "Data for a month is published a few days after the month ends — a sync too early says so rather than failing silently",
        ],
    },
    {
        "provider": "google",
        "label": "Google — GA4 + Search Console",
        "sources": ["ga4_export", "search_console"],
        "blurb": "One service account covers GA4 and Search Console for every client.",
        "agency_fields": [
            {"key": "service_account_json", "label": "Service account JSON", "type": "textarea", "secret": True},
        ],
        "client_fields": [
            {"key": "ga4_property_id", "label": "GA4 property ID", "type": "text",
             "placeholder": "123456789", "hint": "GA4 → Admin → Property settings (numbers only)"},
            {"key": "gsc_site_url", "label": "Search Console property", "type": "text",
             "placeholder": "sc-domain:example.com or https://example.com/",
             "hint": "Exactly as it appears in Search Console"},
        ],
        "key_help": [
            "Go to console.cloud.google.com → create (or pick) a project",
            "APIs & Services → Enable APIs → enable \"Google Analytics Data API\" and \"Google Search Console API\"",
            "IAM & Admin → Service accounts → Create service account (any name, no roles needed)",
            "Open the account → Keys → Add key → Create new key → JSON — a file downloads",
            "Paste the whole JSON file here",
            "Then grant it access per client: in GA4 → Admin → Property access management → add the service account's email as Viewer; in Search Console → Settings → Users → add the same email",
        ],
    },
]

_MODULES = {"ahrefs": ahrefs, "similarweb": similarweb, "google": google}

# source_key -> provider that can feed it
SOURCE_PROVIDERS = {
    src: d["provider"] for d in CONNECTOR_DEFS for src in d["sources"]
}


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
