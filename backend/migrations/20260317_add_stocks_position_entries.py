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
    """
    Retrieve the database connection URL from the environment.
    
    Returns:
        str: The value of the `DATABASE_URL` environment variable.
    
    Raises:
        MigrationError: If `DATABASE_URL` is not set in the environment.
    """
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise MigrationError("DATABASE_URL environment variable must be set for this migration script.")
    return database_url


def upgrade(conn) -> None:
    """
    Add a nullable JSON column named `position_entries` to the `stocks` table if it does not already exist.
    
    If a `position_entries` column exists, verify it is a JSON-compatible type and is nullable; raise `MigrationError` if the existing column has an incompatible type or is not nullable. Ensures the `stocks.position_entries` column exists and allows NULL values.
     
    Raises:
        MigrationError: If `stocks.position_entries` exists with a non-JSON type or exists but is not nullable.
    """
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
    """
    Remove the `position_entries` column from the `stocks` table if it exists.
    
    Parameters:
        conn: An active SQLAlchemy connection or transactional connection used to execute the ALTER TABLE statement.
    """
    conn.execute(text("ALTER TABLE stocks DROP COLUMN IF EXISTS position_entries"))


def run(direction: str) -> None:
    """
    Run the migration in the given direction ("upgrade" or "downgrade").
    
    Executes the selected migration within a transactional connection: configures per-transaction PostgreSQL timeouts, logs the action and SQL dialect, performs the upgrade or downgrade, and disposes the engine when finished.
    
    Parameters:
        direction (str): Either "upgrade" to apply the migration or "downgrade" to revert it.
    
    Raises:
        MigrationError: If `direction` is not "upgrade" or "downgrade".
    """
    if direction not in {"upgrade", "downgrade"}:
        raise MigrationError("direction must be 'upgrade' or 'downgrade'")

    engine = create_engine(get_database_url())
    try:
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
