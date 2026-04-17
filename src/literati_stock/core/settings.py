"""Application settings loaded from environment variables and `.env` file."""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]
LogFormat = Literal["json", "console"]


class Settings(BaseSettings):
    """Strongly-typed application settings.

    Reads environment variables and `.env` at the project root. Instances are
    frozen and reject unknown fields so misnamed env vars surface immediately.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        frozen=True,
        extra="forbid",
    )

    database_url: str = Field(
        min_length=1,
        description="PostgreSQL connection string (sqlalchemy+asyncpg driver).",
    )
    finmind_token: str = Field(
        default="",
        description="FinMind API token; empty string means anonymous quota.",
    )
    log_level: LogLevel = Field(default="INFO")
    log_format: LogFormat = Field(default="console")
    scheduler_timezone: str = Field(default="Asia/Taipei")
    discord_webhook_url: str = Field(
        default="",
        description=(
            "Discord webhook URL for signal notifications. Empty string = "
            "no-op (dev mode). Treated as a secret; never logged with path/token."
        ),
    )
