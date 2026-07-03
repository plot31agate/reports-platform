"""API connectors — pull source data directly instead of CSV uploads.

Each connector fetches from the provider's API and writes a CSV in the exact
format the matching ingestion parser already understands, into the same
data/{client}/{period}/ folder an upload would land in. Everything downstream
(checklist, build, report) is identical for synced and uploaded data.

Adding a provider: implement test(config) and sync(config, source_key, dest,
period) in a module here, then describe it in CONNECTOR_DEFS.
"""
from app.connectors import ahrefs, similarweb, google


# Drives the admin Connections page and the workspace Sync buttons.
# Field types: 'text' | 'password' | 'textarea'. Secret fields are write-only
# in the UI — leaving them blank on save keeps the stored value.
CONNECTOR_DEFS = [
    {
        "provider": "ahrefs",
        "label": "Ahrefs",
        "sources": ["ahrefs_backlinks"],
        "blurb": "Pulls the live backlink profile for the target domain — replaces the ahrefs_backlinks CSV export.",
        "fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True,
             "hint": "Ahrefs → Account settings → API keys (API v3)"},
            {"key": "target", "label": "Target domain", "type": "text",
             "placeholder": "example.com"},
        ],
    },
    {
        "provider": "similarweb",
        "label": "Similarweb",
        "sources": ["similarweb_traffic"],
        "blurb": "Pulls monthly visits for the domain — replaces the similarweb_traffic CSV export.",
        "fields": [
            {"key": "api_key", "label": "API key", "type": "password", "secret": True,
             "hint": "Similarweb → Account → API management"},
            {"key": "domain", "label": "Domain", "type": "text",
             "placeholder": "example.com"},
        ],
    },
    {
        "provider": "google",
        "label": "Google — GA4 + Search Console",
        "sources": ["ga4_export", "search_console"],
        "blurb": "One service account covers both. Create it in Google Cloud, then add its email as a viewer on the GA4 property and the Search Console site.",
        "fields": [
            {"key": "service_account_json", "label": "Service account JSON", "type": "textarea", "secret": True,
             "hint": "Google Cloud → IAM → Service accounts → Keys → Add key (JSON). Paste the whole file."},
            {"key": "ga4_property_id", "label": "GA4 property ID", "type": "text",
             "placeholder": "123456789", "hint": "GA4 → Admin → Property settings (numbers only)"},
            {"key": "gsc_site_url", "label": "Search Console property", "type": "text",
             "placeholder": "sc-domain:example.com or https://example.com/",
             "hint": "Exactly as it appears in Search Console"},
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


def test_connection(provider: str, config: dict) -> tuple[bool, str]:
    """Cheap round-trip to the provider. Returns (ok, human message)."""
    return _MODULES[provider].test(config)


def sync_source(provider: str, config: dict, source_key: str, dest, period: str):
    """Fetch one source for the period and write its CSV to dest (a Path)."""
    return _MODULES[provider].sync(config, source_key, dest, period)
