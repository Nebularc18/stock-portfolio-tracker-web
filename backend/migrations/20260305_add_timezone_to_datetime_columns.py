"""Convert key datetime columns to timezone-aware TIMESTAMPTZ.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py upgrade
    python backend/migrations/20260305_add_timezone_to_datetime_columns.py downgrade
"""

import os
import sys
from sqlalchemy import create_engine, text

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL must be set before running migration 20260305_add_timezone_to_datetime_columns")


def upgrade(conn) -> None:
    conn.execute(text("""
        ALTER TABLE stocks
        ALTER COLUMN last_updated TYPE TIMESTAMPTZ
        USING (last_updated AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE dividends
        ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING (created_at AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE portfolio_history
        ALTER COLUMN date TYPE TIMESTAMPTZ
        USING (date AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE stock_price_history
        ALTER COLUMN recorded_at TYPE TIMESTAMPTZ
        USING (recorded_at AT TIME ZONE 'UTC')
    """))


def downgrade(conn) -> None:
    conn.execute(text("""
        ALTER TABLE stocks
        ALTER COLUMN last_updated TYPE TIMESTAMP
        USING (last_updated AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE dividends
        ALTER COLUMN created_at TYPE TIMESTAMP
        USING (created_at AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE portfolio_history
        ALTER COLUMN date TYPE TIMESTAMP
        USING (date AT TIME ZONE 'UTC')
    """))
    conn.execute(text("""
        ALTER TABLE stock_price_history
        ALTER COLUMN recorded_at TYPE TIMESTAMP
        USING (recorded_at AT TIME ZONE 'UTC')
    """))


def run(direction: str) -> None:
    if direction not in {"upgrade", "downgrade"}:
        raise ValueError("direction must be 'upgrade' or 'downgrade'")

    engine = create_engine(DATABASE_URL)
    with engine.begin() as conn:
        if direction == "upgrade":
            upgrade(conn)
        else:
            downgrade(conn)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "upgrade"
    run(action)
    print(f"Migration completed: {action}")