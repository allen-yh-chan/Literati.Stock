# Literati.Stock

Taiwan equity volume-price analysis system. Internal Literati R&D project; core thesis is **「量先價行」(volume leads price)**.

## Stack

- **Runtime**: Python 3.12, uv, FastAPI, APScheduler, SQLAlchemy 2.0 + asyncpg, PostgreSQL 16, Docker
- **Data**: FinMind (primary), TWSE / TPEx OpenAPI (fallback)
- **Quality**: Pyright strict, Ruff, pytest + testcontainers
- **Process**: OpenSpec spec-driven, Devpro Agent Rules

See `AGENTS.md` for engineering process and `openspec/changes/` for active change proposals.
