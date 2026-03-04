"""Convert key datetime columns to timezone-aware TIMESTAMPTZ.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py upgrade
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py downgrade
"""

import os
import sys
from sqlalchemy import create_engine, text

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
    current_type = _get_column_data_type(conn, table_name, column_name)
    if target == "timestamptz":
        expected_source = "timestamp without time zone"
        desired_type = "timestamp with time zone"
        desired_sql_type = "TIMESTAMPTZ"
    else:
        expected_source = "timestamp with time zone"
        desired_type = "timestamp without time zone"
        desired_sql_type = "TIMESTAMP"

    if current_type == desired_type:
        return

    if current_type != expected_source:
        raise RuntimeError(
            f"Unexpected type for {table_name}.{column_name}: {current_type!r}. "
            f"Expected {expected_source!r} before converting to {desired_type!r}."
        )

    conn.execute(
        text(
            f"""
            ALTER TABLE {table_name}
            ALTER COLUMN {column_name} TYPE {desired_sql_type}
            USING ({column_name} AT TIME ZONE 'UTC')
            """
        )
    )


def upgrade(conn) -> None:
    for table_name, column_name in TARGET_COLUMNS:
        _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamptz")


def downgrade(conn) -> None:
    for table_name, column_name in TARGET_COLUMNS:
        _ensure_and_alter_timezone_column(conn, table_name, column_name, "timestamp")


def run(direction: str) -> None:
    if direction not in {"upgrade", "downgrade"}:
        raise ValueError("direction must be 'upgrade' or 'downgrade'")

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