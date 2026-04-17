"""Argparse tests for new universe-related subcommands."""

from __future__ import annotations

import pytest

from literati_stock.ingest.cli import _build_parser


def test_help_shows_new_subcommands(capsys: pytest.CaptureFixture[str]) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])
    out = capsys.readouterr().out
    assert "refresh-universe" in out
    assert "sync-prices-today" in out


def test_refresh_universe_parses() -> None:
    parser = _build_parser()
    args = parser.parse_args(["refresh-universe"])
    assert args.command == "refresh-universe"


def test_sync_prices_today_as_of_optional() -> None:
    parser = _build_parser()
    args = parser.parse_args(["sync-prices-today"])
    assert args.command == "sync-prices-today"
    assert args.as_of is None

    args2 = parser.parse_args(["sync-prices-today", "--as-of", "2026-04-17"])
    assert args2.as_of == "2026-04-17"
