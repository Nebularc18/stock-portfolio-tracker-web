"""Convert key datetime columns to timezone-aware TIMESTAMPTZ.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py upgrade
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py downgrade

Deployment notes:
    - This migration uses ALTER COLUMN TYPE and can take ACCESS EXCLUSIVE locks.
    - Run in a maintenance or low-traffic window after validating on staging.
    - For large tables, prefer a staged column-copy migration strategy to minimize lock time.
    - Rollback: run this script with "downgrade".
"""

import os
import sys
import logging
from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)

MISSING_DATABASE_URL_MSG = "DATABASE_URL must be set before running migration 20260305_add_timezone_to_datetime_columns"

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(MISSING_DATABASE_URL_MSG)

TARGET_COLUMNS = (
    ("stocks", "last_updated"),
    ("dividends", "created_at"),
    ("portfolio_history", "date"),
    ("stock_price_history", "recorded_at"),
)
ALLOWED_TARGET_COLUMNS = set(TARGET_COLUMNS)
ALLOWED_SQL_TYPES = {"TIMESTAMPTZ", "TIMESTAMP"}


def _get_column_data_type(conn, table_name: str, column_name: str) -> str:
    result = conn.execute(
        text(
            """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :table_name
              AND column_name = :column_name
            """
        ),
        {"table_name": table_name, "column_name": column_name},
    ).scalar()

    if result is None:
        raise RuntimeError(f"Column {table_name}.{column_name} was not found in information_schema.columns")

    return result


def _ensure_and_alter_timezone_column(conn, table_name: str, column_name: str, target: str) -> None:
    if (table_name, column_name) not in ALLOWED_TARGET_COLUMNS:
        raise ValueError(f"Unsupported migration target {table_name}.{column_name}")

    current_type = _get_column_data_type(conn, table_name, column_name)
    if target == "timestamptz":
        expected_source = "timestamp without time zone"
        desired_type = "timestamp with time zone"
        desired_sql_type = "TIMESTAMPTZ"
    elif target == "timestamp":
        expected_source = "timestamp with time zone"
        desired_type = "timestamp without time zone"
        desired_sql_type = "TIMESTAMP"
    else:
        raise ValueError(f"Unsupported target type {target!r}. Allowed values are 'timestamptz' and 'timestamp'.")

    if desired_sql_type not in ALLOWED_SQL_TYPES:
        raise ValueError(f"Unsupported SQL type {desired_sql_type!r}")

    if current_type == desired_type:
        logger.info("Skipping %s.%s: already %s", table_name, column_name, desired_type)
        return

    if current_type != expected_source:
        raise RuntimeError(
            f"Unexpected type for {table_name}.{column_name}: {current_type!r}. "
            f"Expected {expected_source!r} before converting to {desired_type!r}."
        )

    conn.execute(
        text(
            f"""
            ALTER TABLE "{table_name}"
            ALTER COLUMN "{column_name}" TYPE {desired_sql_type}
            USING ("{column_name}" AT TIME ZONE 'UTC')
            """
        )
    )
    logger.info("Converted %s.%s from %s to %s", table_name, column_name, expected_source, desired_type)


def upgrade(conn) -> None:
    for table_name, column_name in TARGET_COLUMNS:
        logger.info("[upgrade] Processing %s.%s", table_name, column_name)
        try:
            _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamptz")
            logger.info("[upgrade] Completed %s.%s", table_name, column_name)
        except Exception:
            logger.exception("[upgrade] Failed %s.%s", table_name, column_name)
            raise


def downgrade(conn) -> None:
    for table_name, column_name in TARGET_COLUMNS:
        logger.info("[downgrade] Processing %s.%s", table_name, column_name)
        try:
            _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamp")
            logger.info("[downgrade] Completed %s.%s", table_name, column_name)
        except Exception:
            logger.exception("[downgrade] Failed %s.%s", table_name, column_name)
            raise


def run(direction: str) -> None:
    if direction not in {"upgrade", "downgrade"}:
        raise ValueError("direction must be 'upgrade' or 'downgrade'")

    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    engine = create_engine(DATABASE_URL)
    try:
        with engine.begin() as conn:
            if direction == "upgrade":
                upgrade(conn)
            else:
                downgrade(conn)
    finally:
        engine.dispose()


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "upgrade"
    run(action)
    print(f"Migration completed: {action}")