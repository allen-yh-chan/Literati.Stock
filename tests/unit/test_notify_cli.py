"""Argparse tests for `literati-signal notify`."""

from __future__ import annotations

import pytest

from literati_stock.signal.cli import _build_parser


def test_help_shows_notify(capsys: pytest.CaptureFixture[str]) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])
    out = capsys.readouterr().out
    assert "notify" in out


def test_notify_parses_as_of() -> None:
    parser = _build_parser()
    args = parser.parse_args(["notify", "--as-of", "2026-04-17"])
    assert args.command == "notify"
    assert args.as_of == "2026-04-17"


def test_notify_as_of_optional() -> None:
    parser = _build_parser()
    args = parser.parse_args(["notify"])
    assert args.command == "notify"
    assert args.as_of is None
