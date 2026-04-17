# syntax=docker/dockerfile:1.7

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /usr/local/bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY src src

# Runtime-only dependencies + the project installed non-editable (goes into
# .venv/lib/python3.12/site-packages, so src/ is not needed at runtime).
RUN uv sync --frozen --no-dev --no-group test --no-editable

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime

RUN groupadd --system app && useradd --system --gid app --no-create-home app

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app migrations ./migrations

USER app

EXPOSE 8000

CMD ["uvicorn", "literati_stock.api.main:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8000"]
