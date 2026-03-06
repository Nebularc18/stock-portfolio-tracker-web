"""Enforce user ownership non-null constraints and per-user stock uniqueness.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260306_enforce_user_ownership_not_null_and_stock_uniqueness.py upgrade
    python backend/migrations/20260306_enforce_user_ownership_not_null_and_stock_uniqueness.py downgrade
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


def _assert_no_null_user_id(conn, table_name: str) -> None:
    null_count = conn.execute(
        text(f"SELECT COUNT(*) FROM {table_name} WHERE user_id IS NULL")
    ).scalar_one()
    if null_count > 0:
        raise MigrationError(
            f"Cannot set {table_name}.user_id NOT NULL while {null_count} row(s) have NULL user_id. "
            "Run the backfill step first."
        )


def upgrade(conn) -> None:
    for table_name in ["stocks", "portfolio_history", "stock_price_history", "user_settings"]:
        _assert_no_null_user_id(conn, table_name)

    conn.execute(
        text(
            "DO $$ BEGIN "
            "IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stocks_ticker_key') THEN "
            "ALTER TABLE stocks DROP CONSTRAINT stocks_ticker_key; "
            "END IF; "
            "END $$;"
        )
    )
    conn.execute(text("DROP INDEX IF EXISTS ix_stocks_ticker"))
    conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_stocks_user_ticker "
            "ON stocks(user_id, ticker)"
        )
    )

    conn.execute(text("ALTER TABLE stocks ALTER COLUMN user_id SET NOT NULL"))
    conn.execute(text("ALTER TABLE portfolio_history ALTER COLUMN user_id SET NOT NULL"))
    conn.execute(text("ALTER TABLE stock_price_history ALTER COLUMN user_id SET NOT NULL"))
    conn.execute(text("ALTER TABLE user_settings ALTER COLUMN user_id SET NOT NULL"))


def downgrade(conn) -> None:
    conn.execute(text("ALTER TABLE stocks ALTER COLUMN user_id DROP NOT NULL"))
    conn.execute(text("ALTER TABLE portfolio_history ALTER COLUMN user_id DROP NOT NULL"))
    conn.execute(text("ALTER TABLE stock_price_history ALTER COLUMN user_id DROP NOT NULL"))
    conn.execute(text("ALTER TABLE user_settings ALTER COLUMN user_id DROP NOT NULL"))

    conn.execute(text("DROP INDEX IF EXISTS ux_stocks_user_ticker"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stocks_ticker ON stocks(ticker)"))
    conn.execute(
        text(
            "DO $$ "
            "DECLARE has_duplicate_tickers BOOLEAN; "
            "BEGIN "
            "SELECT EXISTS ("
            "  SELECT 1 FROM ("
            "    SELECT ticker FROM stocks GROUP BY ticker HAVING COUNT(*) > 1"
            "  ) s"
            ") INTO has_duplicate_tickers; "
            "IF has_duplicate_tickers THEN "
            "  RAISE NOTICE 'Skipping stocks_ticker_key creation because duplicate ticker values exist in stocks'; "
            "ELSIF NOT EXISTS ("
            "  SELECT 1 FROM pg_constraint "
            "  WHERE conname = 'stocks_ticker_key' "
            "    AND conrelid = 'stocks'::regclass"
            ") THEN "
            "  ALTER TABLE stocks ADD CONSTRAINT stocks_ticker_key UNIQUE (ticker); "
            "END IF; "
            "END $$;"
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
        logger.error("Usage: python backend/migrations/20260306_enforce_user_ownership_not_null_and_stock_uniqueness.py <upgrade|downgrade>")
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        logger.error("Invalid action. Use 'upgrade' or 'downgrade'.")
        sys.exit(1)

    run(action)
    logger.info("Migration completed: %s", action)
