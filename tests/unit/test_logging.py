"""Tests for `literati_stock.core.logging`."""

from __future__ import annotations

import json

import pytest

from literati_stock.core.logging import configure_logging, get_logger
from literati_stock.core.settings import Settings


def _settings(log_format: str) -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        database_url="postgresql+asyncpg://x/y",
        finmind_token="",
        log_level="DEBUG",
        log_format=log_format,  # pyright: ignore[reportArgumentType]
        scheduler_timezone="Asia/Taipei",
    )


def test_json_mode_emits_parseable_json(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(_settings("json"))
    get_logger("x").info("hello", k=1)
    out = capsys.readouterr().out.strip()
    assert out, "expected at least one log line"
    parsed = json.loads(out.splitlines()[-1])
    assert parsed["event"] == "hello"
    assert parsed["k"] == 1
    assert parsed["level"] == "info"
    assert "timestamp" in parsed


def test_console_mode_is_not_json(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(_settings("console"))
    get_logger("x").info("hello", k=1)
    out = capsys.readouterr().out.strip()
    assert "hello" in out
    last = out.splitlines()[-1]
    try:
        json.loads(last)
        is_json = True
    except json.JSONDecodeError:
        is_json = False
    assert not is_json, "console mode should not emit JSON"


def test_context_binding_propagates(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(_settings("json"))
    bound = get_logger("x").bind(stock_id="2330", trace_id="abc")
    bound.info("ingest")
    out = capsys.readouterr().out.strip()
    parsed = json.loads(out.splitlines()[-1])
    assert parsed["stock_id"] == "2330"
    assert parsed["trace_id"] == "abc"
