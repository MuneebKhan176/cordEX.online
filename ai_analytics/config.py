import os
from pathlib import Path

from dotenv import load_dotenv

# Same .env the Node app uses (routes/.env at the repo root).
load_dotenv(Path(__file__).resolve().parent.parent / "routes" / ".env")


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


class Settings:
    def __init__(self) -> None:
        self.db_host = os.environ.get("AI_DB_HOST", "localhost")
        self.db_port = int(os.environ.get("AI_DB_PORT", "3306"))
        self.db_name = _require("AI_DB_NAME")
        self.db_user = _require("AI_DB_USER")
        self.db_password = _require("AI_DB_PASSWORD")
        self.internal_secret = _require("AI_INTERNAL_SERVICE_SECRET")

        if len(self.internal_secret) < 32:
            raise RuntimeError("AI_INTERNAL_SERVICE_SECRET must be at least 32 characters")
        if self.db_user.lower() in {"root", "admin"}:
            raise RuntimeError("AI_DB_USER must be the restricted reader account, not an admin account")


settings = Settings()