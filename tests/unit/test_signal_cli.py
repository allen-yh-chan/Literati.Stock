"""Argparse surface tests for `literati-signal`."""

from __future__ import annotations

import pytest

from literati_stock.signal.cli import _build_parser


def test_help_shows_subcommands(capsys: pytest.CaptureFixture[str]) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])
    out = capsys.readouterr().out
    assert "evaluate" in out
    assert "backfill" in out


def test_evaluate_parses_signal_name_and_as_of() -> None:
    parser = _build_parser()
    args = parser.parse_args(["evaluate", "volume_surge_red", "--as-of", "2026-04-17"])
    assert args.command == "evaluate"
    assert args.name == "volume_surge_red"
    assert args.as_of == "2026-04-17"


def test_backfill_parses_range() -> None:
    parser = _build_parser()
    args = parser.parse_args(
        [
            "backfill",
            "volume_surge_red",
            "--start",
            "2025-01-02",
            "--end",
            "2025-03-31",
        ]
    )
    assert args.command == "backfill"
    assert args.start == "2025-01-02"
    assert args.end == "2025-03-31"


def test_backfill_requires_start(capsys: pytest.CaptureFixture[str]) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["backfill", "volume_surge_red"])
    err = capsys.readouterr().err.lower()
    assert "required" in err
