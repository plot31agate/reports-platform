"""Simple session-based auth for the admin area.

One admin account, credentials from env. Sessions are signed cookies.
For a multi-user agency setup later, replace with users-in-DB + proper
password reset flow.
"""
from typing import Optional

from fastapi import Request, HTTPException, status
from itsdangerous import URLSafeSerializer, BadSignature
from passlib.hash import bcrypt

from app.config import settings


COOKIE_NAME = "df_session"
PORTAL_COOKIE_NAME = "df_portal"


def hash_password(plain: str) -> str:
    return bcrypt.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.verify(plain, hashed)
    except Exception:
        return False


def _serializer() -> URLSafeSerializer:
    return URLSafeSerializer(settings.secret_key, salt="df-session")


def create_session_cookie(username: str) -> str:
    return _serializer().dumps({"u": username})


def read_session_cookie(cookie_value: str) -> Optional[str]:
    try:
        data = _serializer().loads(cookie_value)
        return data.get("u")
    except BadSignature:
        return None


def get_current_user(request: Request) -> Optional[str]:
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie:
        return None
    return read_session_cookie(cookie)


# ------------------- client portal sessions -------------------
# Portal users authenticate via an admin-issued invite link. Visiting it sets
# this signed cookie; every portal request re-checks the user row so a revoke
# takes effect immediately.

def _portal_serializer() -> URLSafeSerializer:
    return URLSafeSerializer(settings.secret_key, salt="df-portal")


def create_portal_cookie(user_id: int, client_slug: str) -> str:
    return _portal_serializer().dumps({"uid": user_id, "c": client_slug})


def get_portal_session(request: Request) -> Optional[dict]:
    """Return {'uid': int, 'c': slug} for a valid portal cookie, else None."""
    cookie = request.cookies.get(PORTAL_COOKIE_NAME)
    if not cookie:
        return None
    try:
        data = _portal_serializer().loads(cookie)
    except BadSignature:
        return None
    if not isinstance(data, dict) or "uid" not in data or "c" not in data:
        return None
    return data


def require_admin(request: Request) -> str:
    user = get_current_user(request)
    if not user or user != settings.admin_username:
        raise HTTPException(
            status_code=status.HTTP_303_SEE_OTHER,
            headers={"Location": "/admin/login"},
        )
    return user
