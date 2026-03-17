"""Add nullable position_entries column to stocks table.

Usage:
    python backend/migrations/20260317_add_stocks_position_entries.py upgrade
    python backend/migrations/20260317_add_stocks_position_entries.py downgrade
"""

import os
import sys
import logging
from sqlalchemy import create_engine, inspect, text

logger = logging.getLogger(__name__)


class MigrationError(Exception):
    """Raised when migration arguments or environment are invalid."""


def get_database_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise MigrationError("DATABASE_URL environment variable must be set for this migration script.")
    return database_url


def upgrade(conn) -> None:
    inspector = inspect(conn)
    columns = {column["name"]: column for column in inspector.get_columns("stocks")}
    position_entries_column = columns.get("position_entries")
    if position_entries_column is not None:
        column_type = str(position_entries_column.get("type", "")).upper()
        if "JSON" not in column_type:
            raise MigrationError(f"stocks.position_entries already exists with incompatible type: {column_type}")
        if position_entries_column.get("nullable") is False:
            raise MigrationError("stocks.position_entries already exists but is not nullable")

    conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS position_entries JSON NULL"))


def downgrade(conn) -> None:
    conn.execute(text("ALTER TABLE stocks DROP COLUMN IF EXISTS position_entries"))


def run(direction: str) -> None:
    if direction not in {"upgrade", "downgrade"}:
        raise MigrationError("direction must be 'upgrade' or 'downgrade'")

    engine = create_engine(get_database_url())
    try:
        if engine.dialect.name != "postgresql":
            raise MigrationError(
                f"This migration requires PostgreSQL, but detected dialect '{engine.dialect.name}'. "
                "Use a PostgreSQL DATABASE_URL."
            )
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text("SET LOCAL statement_timeout = '30s'"))
            logger.info(
                "Running migration 20260317_add_stocks_position_entries direction=%s dialect=%s",
                direction,
                engine.dialect.name,
            )
            if direction == "upgrade":
                upgrade(conn)
            else:
                downgrade(conn)
    finally:
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

    if len(sys.argv) != 2:
        logger.error("Usage: python backend/migrations/20260317_add_stocks_position_entries.py <upgrade|downgrade>")
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        logger.error("Invalid action. Use 'upgrade' or 'downgrade'.")
        sys.exit(1)

    try:
        run(action)
    except MigrationError as exc:
        logger.exception("Migration error: %s", exc)
        sys.exit(1)
    except Exception:
        logger.exception("Unexpected error during migration")
        sys.exit(1)

    logger.info("Migration completed: %s", action)
