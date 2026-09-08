"""Credential vault — encryption at rest for client passwords.

The agency stores logins for client systems (WordPress admin, cPanel, social
accounts) so any team member can retrieve them from one place. Those passwords
are encrypted with Fernet (AES-128-CBC + HMAC-SHA256, authenticated) before
they ever touch reporting.db. The key lives in the environment as VAULT_KEY,
never in the database and never in git — so copying the DB file alone yields
nothing. Decryption happens only here, server-side, for an authenticated admin
request, and only on an explicit reveal.

This is a convenience vault at agency scale, not a replacement for a team
password manager with per-person access control. Everything is gated by the
existing admin session and every reveal is stamped in the DB (who, when).
"""
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class VaultError(Exception):
    """Raised when the vault can't encrypt/decrypt — surfaced to the operator."""


def _fernet() -> Fernet:
    key = (settings.vault_key or "").strip()
    if not key:
        raise VaultError(
            "The credential vault is locked — VAULT_KEY is not set. "
            "Add VAULT_KEY to .env to store or read passwords."
        )
    try:
        return Fernet(key.encode())
    except Exception as e:  # malformed key
        raise VaultError("VAULT_KEY is not a valid Fernet key.") from e


def vault_ready() -> bool:
    """True when a usable key is configured — lets the UI show a locked state
    instead of failing on the first save."""
    try:
        _fernet()
        return True
    except VaultError:
        return False


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as e:
        raise VaultError(
            "Could not decrypt this secret — the VAULT_KEY has changed since it "
            "was saved."
        ) from e


def generate_key() -> str:
    """A fresh Fernet key, for seeding a new environment's VAULT_KEY."""
    return Fernet.generate_key().decode()
