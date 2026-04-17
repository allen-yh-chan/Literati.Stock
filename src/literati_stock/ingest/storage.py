"""Persistence helpers for ingest raw payloads and DLQ failure records."""

from __future__ import annotations

import traceback as _traceback
from typing import Any

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from literati_stock.ingest.models import IngestFailure, IngestRaw


class RawPayloadStore:
    """Persists successful ingest payloads for audit / replay."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(
        self,
        dataset: str,
        request_args: dict[str, Any],
        payload: Any,
    ) -> int:
        """Insert one row into `ingest_raw`; return the new id."""
        stmt = (
            pg_insert(IngestRaw)
            .values(
                dataset=dataset,
                request_args=request_args,
                payload=payload,
            )
            .returning(IngestRaw.id)
        )
        result = await self._session.execute(stmt)
        return result.scalar_one()


class FailureRecorder:
    """Persists DLQ records for ingest calls that exhausted retries."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(
        self,
        dataset: str,
        request_args: dict[str, Any],
        exc: BaseException,
        attempts: int,
    ) -> int:
        """Insert one row into `ingest_failure`; return the new id."""
        traceback_text = "".join(_traceback.format_exception(exc))
        stmt = (
            pg_insert(IngestFailure)
            .values(
                dataset=dataset,
                request_args=request_args,
                error_class=type(exc).__name__,
                error_message=str(exc),
                traceback=traceback_text,
                attempts=attempts,
            )
            .returning(IngestFailure.id)
        )
        result = await self._session.execute(stmt)
        return result.scalar_one()
