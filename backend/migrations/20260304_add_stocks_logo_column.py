"""Add nullable logo column to stocks table.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260304_add_stocks_logo_column.py upgrade
    python backend/migrations/20260304_add_stocks_logo_column.py downgrade
"""

import os
import sys
from sqlalchemy import create_engine, text

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable must be set for this migration script.")


def upgrade(conn) -> None:
    conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS logo VARCHAR NULL"))


def downgrade(conn) -> None:
    conn.execute(text("ALTER TABLE stocks DROP COLUMN IF EXISTS logo"))


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
    if len(sys.argv) != 2:
        print("Usage: python backend/migrations/20260304_add_stocks_logo_column.py [upgrade|downgrade]", file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        print("Invalid action. Use 'upgrade' or 'downgrade'.", file=sys.stderr)
        sys.exit(1)

    run(action)
    print(f"Migration completed: {action}")
