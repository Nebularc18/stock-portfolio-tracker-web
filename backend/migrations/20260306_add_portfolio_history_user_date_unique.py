"""Ensure portfolio_history uniqueness uses (user_id, date) for scheduler upserts.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260306_add_portfolio_history_user_date_unique.py upgrade
    python backend/migrations/20260306_add_portfolio_history_user_date_unique.py downgrade
"""

import logging
import os
import sys

from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)


class MigrationError(Exception):
    """Raised when migration preconditions or arguments are invalid."""


def get_database_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise MigrationError("DATABASE_URL environment variable must be set for this migration script.")
    return database_url


def upgrade(conn) -> None:
    conn.execute(
        text(
            "DO $$ BEGIN "
            "IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_history_date_key') THEN "
            "ALTER TABLE portfolio_history DROP CONSTRAINT portfolio_history_date_key; "
            "END IF; END $$;"
        )
    )
    conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_portfolio_history_user_date "
            "ON portfolio_history(user_id, date)"
        )
    )


def downgrade(conn) -> None:
    conn.execute(text("DROP INDEX IF EXISTS ux_portfolio_history_user_date"))
    conn.execute(
        text(
            "DO $$ BEGIN "
            "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_history_date_key') THEN "
            "ALTER TABLE portfolio_history ADD CONSTRAINT portfolio_history_date_key UNIQUE (date); "
            "END IF; END $$;"
        )
    )


def run(direction: str) -> None:
    if direction not in {"upgrade", "downgrade"}:
        raise MigrationError("direction must be 'upgrade' or 'downgrade'")

    engine = create_engine(get_database_url())
    try:
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text("SET LOCAL statement_timeout = '30s'"))
            if direction == "upgrade":
                upgrade(conn)
            else:
                downgrade(conn)
    finally:
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

    if len(sys.argv) != 2:
        logger.error("Usage: python backend/migrations/20260306_add_portfolio_history_user_date_unique.py <upgrade|downgrade>")
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        logger.error("Invalid action. Use 'upgrade' or 'downgrade'.")
        sys.exit(1)

    run(action)
    logger.info("Migration completed: %s", action)
