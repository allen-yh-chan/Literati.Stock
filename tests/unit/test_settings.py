"""Tests for `literati_stock.core.settings`."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from literati_stock.core.settings import Settings


def _build(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    """Construct Settings with monkeypatched env, ignoring any .env on disk."""
    for key, value in env.items():
        monkeypatch.setenv(key.upper(), value)
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


def test_loads_required_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _build(monkeypatch, database_url="postgresql+asyncpg://u:p@h/db")
    assert s.database_url == "postgresql+asyncpg://u:p@h/db"


def test_defaults_apply_when_optional_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _build(monkeypatch, database_url="postgresql+asyncpg://u:p@h/db")
    assert s.finmind_token == ""
    assert s.log_level == "INFO"
    assert s.log_format == "console"
    assert s.scheduler_timezone == "Asia/Taipei"


def test_missing_required_field_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


def test_invalid_log_level_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError):
        _build(
            monkeypatch,
            database_url="postgresql+asyncpg://u:p@h/db",
            log_level="VERBOSE",
        )


def test_unknown_kwarg_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """`extra='forbid'` rejects unknown kwargs (env vars are silently ignored
    by pydantic-settings if no field matches; that is intentional)."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@h/db")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, unknown_field="x")  # pyright: ignore[reportCallIssue]


def test_instance_is_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _build(monkeypatch, database_url="postgresql+asyncpg://u:p@h/db")
    with pytest.raises(ValidationError):
        s.database_url = "mutated"  # type: ignore[misc]
