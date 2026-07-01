"""Generate a SECRET_KEY value for .env.

Usage: python scripts/generate_secret.py
"""
import secrets

print(secrets.token_urlsafe(48))
