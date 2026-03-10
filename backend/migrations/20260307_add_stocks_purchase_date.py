"""Add nullable purchase_date column to stocks table.

Usage:
    python backend/migrations/20260307_add_stocks_purchase_date.py upgrade
    python backend/migrations/20260307_add_stocks_purchase_date.py downgrade
"""

import os
import sys
import logging
from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)


class MigrationError(Exception):
    """Raised when migration arguments or environment are invalid."""


def get_database_url() -> str:
    """
    Retrieve the database connection URL from the environment.
    
    Raises:
        MigrationError: if the DATABASE_URL environment variable is not set.
    
    Returns:
        str: The value of the DATABASE_URL environment variable.
    """
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise MigrationError("DATABASE_URL environment variable must be set for this migration script.")
    return database_url


def upgrade(conn) -> None:
    """
    Add a nullable `purchase_date` DATE column to the `stocks` table if it does not already exist.
    
    Parameters:
        conn: A database connection (SQLAlchemy Connection) used to execute the ALTER TABLE statement.
    """
    conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS purchase_date DATE NULL"))


def downgrade(conn) -> None:
    """
    Remove the `purchase_date` column from the `stocks` table if it exists.
    
    Parameters:
        conn: A DB connection or SQLAlchemy Connection used to execute the DDL statement.
    """
    conn.execute(text("ALTER TABLE stocks DROP COLUMN IF EXISTS purchase_date"))


def run(direction: str) -> None:
    """
    Execute the migration provided by this script in the specified direction.
    
    Parameters:
        direction (str): Either "upgrade" to add the `purchase_date` column to `stocks` or
            "downgrade" to remove that column.
    
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
                "Running migration 20260307_add_stocks_purchase_date direction=%s url=%s",
                direction,
                engine.url.render_as_string(hide_password=True),
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
        logger.error("Usage: python backend/migrations/20260307_add_stocks_purchase_date.py <upgrade|downgrade>")
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        logger.error("Invalid action. Use 'upgrade' or 'downgrade'.")
        sys.exit(1)

    try:
        run(action)
    except MigrationError as exc:
        logger.error("Migration error: %s", exc)
        sys.exit(1)
    except Exception:
        logger.exception("Unexpected error during migration")
        sys.exit(1)

    logger.info("Migration completed: %s", action)
