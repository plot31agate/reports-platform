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


def require_admin(request: Request) -> str:
    user = get_current_user(request)
    if not user or user != settings.admin_username:
        raise HTTPException(
            status_code=status.HTTP_303_SEE_OTHER,
            headers={"Location": "/admin/login"},
        )
    return user
