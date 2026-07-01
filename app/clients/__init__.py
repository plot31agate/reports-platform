"""Client registry.

Each client has: display name, brand tokens (colours/font),
executive names, competitor set, and iGaming context for sentiment.
New clients drop in as new modules and get added to CLIENTS below.
"""
from app.clients.sportingtech import SPORTINGTECH


CLIENTS = {
    "sportingtech": SPORTINGTECH,
}


def get_client(slug: str) -> dict:
    if slug not in CLIENTS:
        raise KeyError(f"Unknown client: {slug}")
    return CLIENTS[slug]
