"""App-wide configuration loaded from environment."""
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "development"
    app_url: str = "http://127.0.0.1:8001"
    secret_key: str = "dev-only-change-in-production"
    session_max_age_seconds: int = 86400

    admin_username: str = "admin"
    admin_password_hash: str = ""

    anthropic_api_key: str = ""
    claude_model_sentiment: str = "claude-haiku-4-5"
    claude_model_synthesis: str = "claude-sonnet-4-6"

    data_dir: Path = Path(__file__).parent.parent / "data"
    reports_out_dir: Path = Path(__file__).parent.parent / "reports_out"
    db_path: Path = Path(__file__).parent.parent / "reporting.db"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

# Ensure runtime dirs exist
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.reports_out_dir.mkdir(parents=True, exist_ok=True)
