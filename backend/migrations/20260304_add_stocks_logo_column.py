"""Add nullable logo column to stocks table.

Manual migration script for projects that do not use Alembic.
Usage:
    python backend/migrations/20260304_add_stocks_logo_column.py upgrade
    python backend/migrations/20260304_add_stocks_logo_column.py downgrade
"""

import os
import sys
from sqlalchemy import create_engine, text


def get_database_url() -> str:
    """Return DATABASE_URL from the environment or raise a runtime error."""
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL environment variable must be set for this migration script.")
    return database_url


def upgrade(conn) -> None:
    """
    Add a nullable "logo" column to the stocks table if it does not already exist.
    
    Parameters:
        conn: An active SQLAlchemy connection or transaction-bound connection used to execute the ALTER TABLE statement.
    """
    conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS logo VARCHAR NULL"))


def downgrade(conn) -> None:
    """
    Remove the `logo` column from the `stocks` table if it exists.
    
    Parameters:
    	conn: A SQLAlchemy Connection or transactional connection on which the DROP COLUMN statement will be executed.
    """
    conn.execute(text("ALTER TABLE stocks DROP COLUMN IF EXISTS logo"))


def run(direction: str) -> None:
    """
    Execute the migration in the given direction within a transactional database connection.
    
    Parameters:
        direction (str): Either "upgrade" to add the nullable `logo` column to the `stocks` table
            or "downgrade" to remove that column.
    
    Raises:
        ValueError: If `direction` is not "upgrade" or "downgrade".
    """
    if direction not in {"upgrade", "downgrade"}:
        raise ValueError("direction must be 'upgrade' or 'downgrade'")

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
    if len(sys.argv) != 2:
        print("Usage: python backend/migrations/20260304_add_stocks_logo_column.py <upgrade|downgrade>", file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    if action not in {"upgrade", "downgrade"}:
        print("Invalid action. Use 'upgrade' or 'downgrade'.", file=sys.stderr)
        sys.exit(1)

    run(action)
    print(f"Migration completed: {action}")
