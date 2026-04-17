"""Detects upstream schema drift by validating sample payloads' field sets."""

from __future__ import annotations

import structlog

from literati_stock.ingest.clients.finmind import FinMindClient
from literati_stock.ingest.schemas.finmind_raw import EXPECTED_FIELDS

logger = structlog.get_logger(__name__)


class SchemaDriftError(Exception):
    """Raised when a fetched sample's field set diverges from expectations."""

    def __init__(self, dataset: str, added: frozenset[str], removed: frozenset[str]) -> None:
        self.dataset = dataset
        self.added = added
        self.removed = removed
        super().__init__(
            f"Schema drift in {dataset}: added={sorted(added)}, removed={sorted(removed)}"
        )


class SentinelEmptyResponseError(Exception):
    """Sample query returned zero rows; drift status cannot be determined."""


class SchemaSentinel:
    """Checks that a dataset's sample response still matches `EXPECTED_FIELDS`."""

    def __init__(self, client: FinMindClient) -> None:
        self._client = client

    async def check(
        self,
        dataset: str,
        *,
        data_id: str,
        start_date: str,
        end_date: str | None = None,
    ) -> None:
        """Raise `SchemaDriftError` if the sample row's keys differ from expected.

        Raises `SentinelEmptyResponseError` if the sample query returns no rows.
        Raises `KeyError` if the dataset has no `EXPECTED_FIELDS` entry
        (misuse: caller must register expectations before running the sentinel).
        """
        try:
            expected = EXPECTED_FIELDS[dataset]
        except KeyError as exc:
            raise KeyError(f"no EXPECTED_FIELDS entry registered for dataset {dataset!r}") from exc

        log = logger.bind(dataset=dataset, data_id=data_id, start_date=start_date)
        rows = await self._client.fetch(
            dataset, data_id=data_id, start_date=start_date, end_date=end_date
        )
        if not rows:
            log.warning("sentinel.empty_sample")
            raise SentinelEmptyResponseError(
                f"sample query for {dataset} returned 0 rows; cannot verify schema"
            )

        actual = frozenset(rows[0].keys())
        if actual == expected:
            log.debug("sentinel.ok", fields=len(actual))
            return

        added = frozenset(actual - expected)
        removed = frozenset(expected - actual)
        log.error("sentinel.drift", added=sorted(added), removed=sorted(removed))
        raise SchemaDriftError(dataset, added=added, removed=removed)
