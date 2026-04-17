"""Tests for the argparse surface of `literati-ingest`."""

from __future__ import annotations

import pytest

from literati_stock.ingest.cli import _build_parser


def test_help_shows_run_once_subcommand(
    capsys: pytest.CaptureFixture[str],
) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])
    out = capsys.readouterr().out
    assert "run-once" in out


def test_run_once_parses_required_args() -> None:
    parser = _build_parser()
    args = parser.parse_args(
        [
            "run-once",
            "TaiwanStockPrice",
            "--data-id",
            "2330",
            "--start",
            "2025-01-02",
            "--end",
            "2025-01-03",
        ]
    )
    assert args.command == "run-once"
    assert args.dataset == "TaiwanStockPrice"
    assert args.data_id == "2330"
    assert args.start == "2025-01-02"
    assert args.end == "2025-01-03"


def test_run_once_missing_required_fails(
    capsys: pytest.CaptureFixture[str],
) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["run-once", "TaiwanStockPrice"])
    err = capsys.readouterr().err
    assert "required" in err.lower()
