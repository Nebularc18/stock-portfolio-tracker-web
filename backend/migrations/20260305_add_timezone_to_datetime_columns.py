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
    """
    Retrieve the SQL `data_type` of a column in the public schema.
    
    Queries information_schema.columns for the given table and column names within the `public` schema.
    
    Parameters:
        table_name (str): Name of the table in the `public` schema.
        column_name (str): Name of the column in the table.
    
    Returns:
        data_type (str): The column's SQL `data_type` as reported by information_schema.columns.
    
    Raises:
        RuntimeError: If the specified table.column is not found in information_schema.columns.
    """
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
    """
    Ensure a permitted datetime column is converted to the specified timestamp type and perform the ALTER TABLE conversion if required.
    
    Parameters:
    	conn: A DBAPI/SQLAlchemy connection used to execute queries.
    	table_name (str): Name of the table containing the target column.
    	column_name (str): Name of the datetime column to convert.
    	target (str): Desired target type identifier; allowed values are `"timestamptz"` (convert to timestamp with time zone) and `"timestamp"` (convert to timestamp without time zone).
    
    Raises:
    	ValueError: If the (table_name, column_name) pair is not allowed, if `target` is unsupported, or if the resolved SQL type is not permitted.
    	RuntimeError: If the column's current data type does not match the expected source type for the requested conversion.
    """
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
    """
    Convert the configured datetime columns to timezone-aware TIMESTAMPTZ using the provided database connection.
    
    Iterates over TARGET_COLUMNS and alters each column to TIMESTAMPTZ; any exception raised during a column conversion is propagated.
    
    Parameters:
        conn: A SQLAlchemy Connection (typically within a transactional context) used to execute the schema changes.
    
    Raises:
        Exception: Propagates any error encountered while converting a column.
    """
    for table_name, column_name in TARGET_COLUMNS:
        logger.info("[upgrade] Processing %s.%s", table_name, column_name)
        try:
            _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamptz")
            logger.info("[upgrade] Completed %s.%s", table_name, column_name)
        except Exception:
            logger.exception("[upgrade] Failed %s.%s", table_name, column_name)
            raise


def downgrade(conn) -> None:
    """
    Reverts each target column to a timezone-naive TIMESTAMP (timestamp without time zone).
    
    Iterates over TARGET_COLUMNS and attempts to alter each column back to a timestamp without time zone,
    logging progress for each column. If a column conversion fails, the exception is logged and re-raised.
    Parameters:
        conn: A transactional SQLAlchemy connection used to execute the ALTER TABLE statements.
    """
    for table_name, column_name in TARGET_COLUMNS:
        logger.info("[downgrade] Processing %s.%s", table_name, column_name)
        try:
            _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamp")
            logger.info("[downgrade] Completed %s.%s", table_name, column_name)
        except Exception:
            logger.exception("[downgrade] Failed %s.%s", table_name, column_name)
            raise


def run(direction: str) -> None:
    """
    Run the migration in the given direction within a short-timeout transactional connection.
    
    Validates `direction` is either "upgrade" or "downgrade", ensures a basic logging configuration exists if none is set, creates a SQLAlchemy engine from the module DATABASE_URL, opens a transactional connection with short local lock and statement timeouts, executes the requested migration (calls `upgrade` or `downgrade`), and disposes the engine when finished.
    
    Parameters:
        direction (str): Either "upgrade" to convert target columns to TIMESTAMPTZ or "downgrade" to revert them to TIMESTAMP.
    """
    if direction not in {"upgrade", "downgrade"}:
        raise ValueError("direction must be 'upgrade' or 'downgrade'")

    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    engine = create_engine(DATABASE_URL)
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
    allowed_actions = {"upgrade", "downgrade"}
    if len(sys.argv) != 2 or sys.argv[1] not in allowed_actions:
        print(
            "Usage: python backend/migrations/20260305_add_timezone_to_datetime_columns.py "
            "<upgrade|downgrade>",
            file=sys.stderr,
        )
        sys.exit(1)

    action = sys.argv[1]
    run(action)
    print(f"Migration completed: {action}")