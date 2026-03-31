"""Stock Portfolio Tracker API.

This module defines the FastAPI application, database models, Pydantic
schemas, and API routing configuration for the stock portfolio tracker.
"""

import os
import math
import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import List, Optional, Any
import logging

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv
from passlib.context import CryptContext
from passlib.exc import UnknownHashError
from pydantic import BaseModel, field_validator, model_validator
from sqlalchemy import create_engine, Column, Integer, String, Float, Date, DateTime, ForeignKey, JSON, Boolean, text, UniqueConstraint, bindparam
from sqlalchemy.orm import sessionmaker, relationship, declarative_base
from sqlalchemy.pool import NullPool
from app.utils.time import utc_now
from app.services.position_service import calculate_position_snapshot, normalize_position_entries

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
load_dotenv(os.path.join(ROOT_DIR, '.env'))

logger = logging.getLogger(__name__)


def _get_request_timing_warn_ms() -> float:
    default_value = 800.0
    raw_value = os.getenv("REQUEST_TIMING_WARN_MS")
    if raw_value is None:
        return default_value

    try:
        parsed_value = float(raw_value)
    except (TypeError, ValueError):
        logger.warning("Invalid REQUEST_TIMING_WARN_MS=%r; using default %.1f", raw_value, default_value)
        return default_value

    if not math.isfinite(parsed_value):
        logger.warning("Non-finite REQUEST_TIMING_WARN_MS=%r; using default %.1f", raw_value, default_value)
        return default_value

    if parsed_value <= 0:
        logger.warning("Non-positive REQUEST_TIMING_WARN_MS=%r; using default %.1f", raw_value, default_value)
        return default_value

    return parsed_value


REQUEST_TIMING_WARN_MS = _get_request_timing_warn_ms()

ALLOWED_USER_FK_CONSTRAINTS = {
    "stocks": "fk_stocks_user_id_users",
    "user_settings": "fk_user_settings_user_id_users",
    "portfolio_history": "fk_portfolio_history_user_id_users",
    "stock_price_history": "fk_stock_price_history_user_id_users",
}

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://portfolio:portfolio@localhost:5432/portfolio")

engine = create_engine(DATABASE_URL, poolclass=NullPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    """Hash a plain-text password using Argon2."""
    return pwd_context.hash(password)


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a plain-text password against a stored Argon2 hash."""
    try:
        return pwd_context.verify(password, stored_hash)
    except (UnknownHashError, ValueError, TypeError):
        return False


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(f"{raw}{padding}")


def _get_required_env(var_name: str) -> str:
    value = os.getenv(var_name)
    if value:
        return value
    raise RuntimeError(f"Missing required environment variable: {var_name}")


def _get_auth_token_ttl_seconds() -> int:
    raw_ttl = os.getenv("AUTH_TOKEN_TTL_SECONDS", "43200")
    try:
        ttl_seconds = int(raw_ttl)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("AUTH_TOKEN_TTL_SECONDS must be a positive integer number of seconds") from exc

    if ttl_seconds <= 0:
        raise RuntimeError("AUTH_TOKEN_TTL_SECONDS must be a positive integer number of seconds")

    return ttl_seconds


def validate_startup_env() -> None:
    """Validate required security-sensitive environment variables."""
    required = ["DEFAULT_USERNAME", "DEFAULT_PASSWORD", "GUEST_USERNAME", "AUTH_TOKEN_SECRET"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(f"Missing required environment variables: {joined}")


def validate_auth_token_secret() -> None:
    """Validate auth token settings required for token operations."""
    _get_required_env("AUTH_TOKEN_SECRET")
    _get_auth_token_ttl_seconds()


def create_access_token(user_id: int) -> str:
    """Create a signed bearer token for a specific user id."""
    secret = _get_required_env("AUTH_TOKEN_SECRET")
    ttl_seconds = _get_auth_token_ttl_seconds()
    issued_at = int(time.time())
    payload = {
        "sub": user_id,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": uuid.uuid4().hex,
    }
    issuer = os.getenv("AUTH_TOKEN_ISSUER")
    audience = os.getenv("AUTH_TOKEN_AUDIENCE")
    if issuer:
        payload["iss"] = issuer
    if audience:
        payload["aud"] = audience
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = _b64url_encode(payload_bytes)
    signature = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    signature_b64 = _b64url_encode(signature)
    return f"{payload_b64}.{signature_b64}"


def verify_access_token(token: str) -> int:
    """Validate a bearer token and return the canonical user id."""
    secret = _get_required_env("AUTH_TOKEN_SECRET")
    expected_issuer = os.getenv("AUTH_TOKEN_ISSUER")
    expected_audience = os.getenv("AUTH_TOKEN_AUDIENCE")
    try:
        payload_b64, signature_b64 = token.split(".", 1)
    except ValueError as exc:
        raise ValueError("Malformed token") from exc

    expected_signature = hmac.new(
        secret.encode("utf-8"),
        payload_b64.encode("ascii"),
        hashlib.sha256,
    ).digest()
    try:
        provided_signature = _b64url_decode(signature_b64)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Malformed token signature") from exc

    if not hmac.compare_digest(provided_signature, expected_signature):
        raise ValueError("Invalid token signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        user_id = int(payload["sub"])
        exp = int(payload["exp"])
    except (KeyError, ValueError, TypeError, json.JSONDecodeError, binascii.Error) as exc:
        raise ValueError("Malformed token payload") from exc

    if expected_issuer and payload.get("iss") != expected_issuer:
        raise ValueError("Invalid token issuer")

    if expected_audience and payload.get("aud") != expected_audience:
        raise ValueError("Invalid token audience")

    if exp <= int(time.time()):
        raise ValueError("Token expired")

    return user_id


class User(Base):
    """Database model representing an application user account."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    is_guest = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class Stock(Base):
    """Database model representing a stock in the portfolio.
    
    Attributes:
        id: Primary key.
        ticker: Stock ticker symbol.
        name: Company name.
        quantity: Number of shares owned.
        currency: Trading currency (default 'USD').
        sector: Company sector.
        logo: URL to company logo image.
        purchase_price: Average purchase price per share.
        position_entries: Historical buy lots with optional sell dates.
        current_price: Current market price.
        previous_close: Previous day's closing price.
        dividend_yield: Annual dividend yield percentage.
        dividend_per_share: Annual dividend per share.
        last_updated: Timestamp of last data refresh.
        manual_dividends: List of manually recorded dividends.
        suppressed_dividends: List of suppressed broker dividends.
    """
    __tablename__ = "stocks"
    __table_args__ = (
        UniqueConstraint("user_id", "ticker", name="ux_stocks_user_ticker"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", name="fk_stocks_user_id_users"), index=True, nullable=False)
    ticker = Column(String, index=True, nullable=False)
    name = Column(String)
    quantity = Column(Float, default=0)
    currency = Column(String, default="USD")
    sector = Column(String)
    logo = Column(String, nullable=True)
    purchase_price = Column(Float, nullable=True)
    purchase_date = Column(Date, nullable=True)
    position_entries = Column(JSON, default=list)
    current_price = Column(Float, nullable=True)
    previous_close = Column(Float, nullable=True)
    dividend_yield = Column(Float, nullable=True)
    dividend_per_share = Column(Float, nullable=True)
    last_updated = Column(DateTime(timezone=True), default=utc_now)
    manual_dividends = Column(JSON, default=list)
    suppressed_dividends = Column(JSON, default=list)

    dividends = relationship("Dividend", back_populates="stock")


class Dividend(Base):
    """Database model representing a dividend payment.
    
    Attributes:
        id: Primary key.
        stock_id: Foreign key to the Stock model.
        amount: Dividend amount per share.
        currency: Dividend currency.
        ex_date: Ex-dividend date.
        pay_date: Payment date.
        created_at: Record creation timestamp.
    """
    __tablename__ = "dividends"

    id = Column(Integer, primary_key=True, index=True)
    stock_id = Column(Integer, ForeignKey("stocks.id"))
    amount = Column(Float)
    currency = Column(String)
    ex_date = Column(DateTime(timezone=True), nullable=True)
    pay_date = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    stock = relationship("Stock", back_populates="dividends")


class PortfolioHistory(Base):
    """Database model for portfolio value snapshots.
    
    Attributes:
        id: Primary key.
        total_value: Total portfolio value in SEK.
        date: Snapshot timestamp (unique).
    """
    __tablename__ = "portfolio_history"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="ux_portfolio_history_user_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", name="fk_portfolio_history_user_id_users"), index=True, nullable=False)
    total_value = Column(Float)
    date = Column(DateTime(timezone=True), default=utc_now)


class StockPriceHistory(Base):
    """Database model for historical stock prices.
    
    Attributes:
        id: Primary key.
        ticker: Stock ticker symbol.
        price: Recorded price.
        currency: Price currency.
        recorded_at: Recording timestamp.
    """
    __tablename__ = "stock_price_history"
    __table_args__ = (
        UniqueConstraint("user_id", "ticker", "recorded_at", name="ux_stock_price_history_user_ticker_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", name="fk_stock_price_history_user_id_users"), index=True, nullable=False)
    ticker = Column(String, index=True, nullable=False)
    price = Column(Float, nullable=False)
    currency = Column(String, nullable=False)
    recorded_at = Column(DateTime(timezone=True), default=utc_now, index=True)


class UserSettings(Base):
    """Database model for user preferences.
    
    Attributes:
        id: Primary key.
        display_currency: Preferred display currency (default 'SEK').
        header_indices: JSON string of selected header indices symbols.
        platforms: JSON string of selected broker/platform names.
    """
    __tablename__ = "user_settings"
    __table_args__ = (
        UniqueConstraint("user_id", name="ux_user_settings_user_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", name="fk_user_settings_user_id_users"), index=True, nullable=False)
    display_currency = Column(String, default="SEK")
    header_indices = Column(String, default="[]")
    platforms = Column(String, default="[]")


class SharedTickerMapping(Base):
    """Shared Avanza-to-Yahoo ticker mappings visible to all users of the app."""

    __tablename__ = "shared_ticker_mappings"
    __table_args__ = (
        UniqueConstraint("avanza_name", name="ux_shared_ticker_mappings_avanza_name"),
        UniqueConstraint("yahoo_ticker", name="ux_shared_ticker_mappings_yahoo_ticker"),
    )

    id = Column(Integer, primary_key=True, index=True)
    avanza_name = Column(String, nullable=False)
    yahoo_ticker = Column(String, index=True, nullable=False)
    instrument_id = Column(String, nullable=True)
    manually_added = Column(Boolean, default=True, nullable=False)
    added_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)


Base.metadata.create_all(bind=engine)


def ensure_account_schema_and_seed() -> None:
    """Backfill auth-related schema and seed default/guest users with demo data."""
    validate_startup_env()

    default_username = _get_required_env("DEFAULT_USERNAME")
    default_password = _get_required_env("DEFAULT_PASSWORD")
    guest_username = _get_required_env("GUEST_USERNAME")
    guest_password = os.getenv("GUEST_PASSWORD") or secrets.token_urlsafe(24)

    def ensure_user_foreign_key(table_name: str, constraint_name: str) -> None:
        expected_constraint_name = ALLOWED_USER_FK_CONSTRAINTS.get(table_name)
        if expected_constraint_name != constraint_name:
            raise ValueError(f"Unsupported foreign key target: {table_name}.{constraint_name}")

        conn.execute(text(f"""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE contype = 'f'
                      AND conrelid = '{table_name}'::regclass
                      AND confrelid = 'users'::regclass
                      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '{table_name}'::regclass AND attname = 'user_id')]::smallint[]
                      AND confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'id')]::smallint[]
                ) THEN
                    ALTER TABLE {table_name}
                    ADD CONSTRAINT {constraint_name}
                    FOREIGN KEY (user_id) REFERENCES users(id);
                END IF;
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        """))

    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR NOT NULL UNIQUE,
                password_hash VARCHAR NOT NULL,
                is_guest BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))

        conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS purchase_date DATE"))
        conn.execute(text("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS position_entries JSON"))
        conn.execute(text("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS platforms VARCHAR(1000) DEFAULT '[]'"))
        conn.execute(text("ALTER TABLE portfolio_history ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("ALTER TABLE stock_price_history ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS shared_ticker_mappings (
                id SERIAL PRIMARY KEY,
                avanza_name VARCHAR NOT NULL,
                yahoo_ticker VARCHAR NOT NULL,
                instrument_id VARCHAR NULL,
                manually_added BOOLEAN NOT NULL DEFAULT TRUE,
                added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_shared_ticker_mappings_avanza_name ON shared_ticker_mappings (avanza_name)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_shared_ticker_mappings_yahoo_ticker ON shared_ticker_mappings (yahoo_ticker)"))

        conn.execute(text("""
            INSERT INTO users (username, password_hash, is_guest)
            VALUES (:username, :password_hash, FALSE)
            ON CONFLICT (username) DO NOTHING
        """), {
            "username": default_username,
            "password_hash": hash_password(default_password),
        })

        conn.execute(text("""
            INSERT INTO users (username, password_hash, is_guest)
            VALUES (:username, :password_hash, TRUE)
            ON CONFLICT (username) DO NOTHING
        """), {
            "username": guest_username,
            "password_hash": hash_password(guest_password),
        })

        default_user_id = conn.execute(
            text("SELECT id FROM users WHERE username = :username"),
            {"username": default_username},
        ).scalar_one()
        guest_user = conn.execute(
            text("SELECT id, is_guest FROM users WHERE username = :username"),
            {"username": guest_username},
        ).mappings().one_or_none()
        if guest_user is None:
            raise RuntimeError(f"Configured guest user '{guest_username}' was not found after startup seeding")
        if not guest_user["is_guest"]:
            raise RuntimeError(
                f"Configured guest username '{guest_username}' belongs to a non-guest account. "
                "Use a dedicated guest username or remediate the existing user before startup seeding can continue."
            )
        guest_user_id = guest_user["id"]

        conn.execute(text("UPDATE stocks SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE user_settings SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE portfolio_history SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE stock_price_history SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})

        for table_name in ("stocks", "user_settings", "portfolio_history", "stock_price_history"):
            orphaned_user_id_count = conn.execute(text(f"""
                SELECT COUNT(*)
                FROM {table_name}
                WHERE user_id IS NOT NULL
                  AND user_id NOT IN (SELECT id FROM users)
            """)).scalar_one()
            if orphaned_user_id_count > 0:
                raise RuntimeError(
                    f"Cannot backfill {table_name}: found {orphaned_user_id_count} rows with orphaned non-NULL user_id values. "
                    "Remediate these rows explicitly before startup seeding can continue."
                )

        conn.execute(text("ALTER TABLE stocks ALTER COLUMN user_id SET NOT NULL"))
        conn.execute(text("ALTER TABLE user_settings ALTER COLUMN user_id SET NOT NULL"))
        conn.execute(text("ALTER TABLE portfolio_history ALTER COLUMN user_id SET NOT NULL"))
        conn.execute(text("ALTER TABLE stock_price_history ALTER COLUMN user_id SET NOT NULL"))

        ensure_user_foreign_key("stocks", "fk_stocks_user_id_users")
        ensure_user_foreign_key("user_settings", "fk_user_settings_user_id_users")
        ensure_user_foreign_key("portfolio_history", "fk_portfolio_history_user_id_users")
        ensure_user_foreign_key("stock_price_history", "fk_stock_price_history_user_id_users")

        duplicate_user_settings = conn.execute(text("""
            SELECT user_id, COUNT(*) AS row_count
            FROM user_settings
            GROUP BY user_id
            HAVING COUNT(*) > 1
            LIMIT 1
        """)).mappings().one_or_none()
        if duplicate_user_settings is not None:
            raise RuntimeError(
                "Cannot create ux_user_settings_user_id on user_settings: "
                f"found duplicate rows for user_id {duplicate_user_settings['user_id']} "
                f"(count={duplicate_user_settings['row_count']})."
            )

        conn.execute(text("ALTER TABLE stocks DROP CONSTRAINT IF EXISTS stocks_ticker_key"))
        conn.execute(text("DROP INDEX IF EXISTS ix_stocks_ticker"))
        conn.execute(text("ALTER TABLE portfolio_history DROP CONSTRAINT IF EXISTS portfolio_history_date_key"))

        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stocks_ticker ON stocks(ticker)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_stocks_user_ticker ON stocks(user_id, ticker)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_portfolio_history_user_date ON portfolio_history(user_id, date)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_price_history_user_ticker_date ON stock_price_history(user_id, ticker, recorded_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stock_price_history_user_ticker ON stock_price_history(user_id, ticker)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_user_settings_user_id ON user_settings(user_id)"))

        now = utc_now()
        guest_stocks = [
            {
                "ticker": "VOLV-B.ST",
                "name": "Volvo B",
                "quantity": 28.0,
                "currency": "SEK",
                "sector": "Industrials",
                "purchase_price": 245.0,
                "purchase_date": date(2024, 2, 15),
                "current_price": 273.5,
                "previous_close": 271.8,
                "dividend_yield": 3.2,
                "dividend_per_share": 8.8,
            },
            {
                "ticker": "AAPL",
                "name": "Apple Inc.",
                "quantity": 12.0,
                "currency": "USD",
                "sector": "Technology",
                "purchase_price": 178.0,
                "purchase_date": date(2024, 11, 1),
                "current_price": 195.3,
                "previous_close": 194.2,
                "dividend_yield": 0.5,
                "dividend_per_share": 0.96,
            },
            {
                "ticker": "SAP.DE",
                "name": "SAP SE",
                "quantity": 10.0,
                "currency": "EUR",
                "sector": "Technology",
                "purchase_price": 162.5,
                "purchase_date": date(2024, 10, 10),
                "current_price": 174.9,
                "previous_close": 174.0,
                "dividend_yield": 1.6,
                "dividend_per_share": 2.2,
            },
            {
                "ticker": "ASML.AS",
                "name": "ASML Holding",
                "quantity": 4.0,
                "currency": "EUR",
                "sector": "Basic Materials",
                "purchase_price": 812.0,
                "purchase_date": date(2024, 8, 19),
                "current_price": 864.2,
                "previous_close": 859.6,
                "dividend_yield": 0.9,
                "dividend_per_share": 6.1,
            },
            {
                "ticker": "SHEL.L",
                "name": "Shell plc",
                "quantity": 24.0,
                "currency": "GBP",
                "sector": "Energy",
                "purchase_price": 25.1,
                "purchase_date": date(2024, 7, 8),
                "current_price": 27.4,
                "previous_close": 27.2,
                "dividend_yield": 4.0,
                "dividend_per_share": 1.36,
            },
            {
                "ticker": "NESN.SW",
                "name": "Nestle SA",
                "quantity": 9.0,
                "currency": "CHF",
                "sector": "Consumer Defensive",
                "purchase_price": 96.5,
                "purchase_date": date(2024, 5, 6),
                "current_price": 103.8,
                "previous_close": 103.1,
                "dividend_yield": 2.8,
                "dividend_per_share": 3.05,
            },
            {
                "ticker": "SHOP.TO",
                "name": "Shopify Inc.",
                "quantity": 11.0,
                "currency": "CAD",
                "sector": "Technology",
                "purchase_price": 98.4,
                "purchase_date": date(2024, 9, 12),
                "current_price": 112.6,
                "previous_close": 111.4,
                "dividend_yield": 0.0,
                "dividend_per_share": 0.0,
            },
            {
                "ticker": "RIO.AX",
                "name": "Rio Tinto",
                "quantity": 14.0,
                "currency": "AUD",
                "sector": "Technology",
                "purchase_price": 118.0,
                "purchase_date": date(2024, 3, 21),
                "current_price": 126.4,
                "previous_close": 125.7,
                "dividend_yield": 4.3,
                "dividend_per_share": 5.2,
            },
            {
                "ticker": "OR.PA",
                "name": "L'Oreal",
                "quantity": 6.0,
                "currency": "EUR",
                "sector": "Consumer Defensive",
                "purchase_price": 421.0,
                "purchase_date": date(2024, 6, 17),
                "current_price": 446.7,
                "previous_close": 444.2,
                "dividend_yield": 1.3,
                "dividend_per_share": 6.6,
            },
            {
                "ticker": "MSFT",
                "name": "Microsoft Corp.",
                "quantity": 7.0,
                "currency": "USD",
                "sector": "Technology",
                "purchase_price": 398.0,
                "purchase_date": date(2024, 4, 11),
                "current_price": 426.5,
                "previous_close": 424.7,
                "dividend_yield": 0.7,
                "dividend_per_share": 3.0,
            },
        ]

        guest_tickers = [stock["ticker"] for stock in guest_stocks]
        conn.execute(text("DELETE FROM stocks WHERE user_id = :user_id AND ticker NOT IN :tickers").bindparams(bindparam("tickers", expanding=True)), {
            "user_id": guest_user_id,
            "tickers": guest_tickers,
        })

        for stock in guest_stocks:
            position_snapshot = calculate_position_snapshot([{
                "quantity": stock["quantity"],
                "purchase_price": stock["purchase_price"],
                "purchase_date": stock["purchase_date"],
                "sell_date": None,
            }], position_currency=stock.get("currency"))
            conn.execute(text("""
                INSERT INTO stocks (
                    user_id, ticker, name, quantity, currency, sector, purchase_price,
                    purchase_date, position_entries,
                    current_price, previous_close, dividend_yield, dividend_per_share,
                    last_updated, manual_dividends, suppressed_dividends
                ) VALUES (
                    :user_id, :ticker, :name, :quantity, :currency, :sector, :purchase_price,
                    :purchase_date, :position_entries,
                    :current_price, :previous_close, :dividend_yield, :dividend_per_share,
                    :last_updated, '[]'::json, '[]'::json
                )
                ON CONFLICT (user_id, ticker) DO UPDATE SET
                    name = EXCLUDED.name,
                    quantity = EXCLUDED.quantity,
                    currency = EXCLUDED.currency,
                    sector = EXCLUDED.sector,
                    purchase_price = EXCLUDED.purchase_price,
                    purchase_date = EXCLUDED.purchase_date,
                    position_entries = EXCLUDED.position_entries,
                    current_price = EXCLUDED.current_price,
                    previous_close = EXCLUDED.previous_close,
                    dividend_yield = EXCLUDED.dividend_yield,
                    dividend_per_share = EXCLUDED.dividend_per_share,
                    last_updated = EXCLUDED.last_updated,
                    manual_dividends = '[]'::json,
                    suppressed_dividends = '[]'::json
            """), {
                "user_id": guest_user_id,
                "ticker": stock["ticker"],
                "name": stock["name"],
                "quantity": stock["quantity"],
                "currency": stock["currency"],
                "sector": stock["sector"],
                "purchase_price": stock["purchase_price"],
                "purchase_date": stock["purchase_date"],
                "position_entries": json.dumps(position_snapshot["position_entries"]),
                "current_price": stock["current_price"],
                "previous_close": stock["previous_close"],
                "dividend_yield": stock["dividend_yield"],
                "dividend_per_share": stock["dividend_per_share"],
                "last_updated": now,
            })

        legacy_mapping_path = Path(ROOT_DIR) / "backend" / "data" / "ticker_mapping.json"
        if legacy_mapping_path.is_file():
            try:
                legacy_payload = json.loads(legacy_mapping_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                logger.exception("Failed to read legacy ticker mapping file from %s", legacy_mapping_path)
            else:
                for item in legacy_payload.get("mappings", []):
                    avanza_name = str(item.get("avanza_name") or "").strip()
                    yahoo_ticker = str(item.get("yahoo_ticker") or "").strip().upper()
                    instrument_id = item.get("instrument_id")
                    if instrument_id is not None:
                        instrument_id = str(instrument_id).strip() or None
                    manually_added = bool(item.get("manually_added", True))
                    added_at = item.get("added_at")
                    if not avanza_name or not yahoo_ticker:
                        continue

                    existing_by_name = conn.execute(text("""
                        SELECT id
                        FROM shared_ticker_mappings
                        WHERE LOWER(avanza_name) = LOWER(:avanza_name)
                        LIMIT 1
                    """), {
                        "avanza_name": avanza_name,
                    }).scalar_one_or_none()
                    existing_by_ticker = conn.execute(text("""
                        SELECT id
                        FROM shared_ticker_mappings
                        WHERE UPPER(yahoo_ticker) = UPPER(:yahoo_ticker)
                        LIMIT 1
                    """), {
                        "yahoo_ticker": yahoo_ticker,
                    }).scalar_one_or_none()

                    if (
                        existing_by_name is not None
                        and existing_by_ticker is not None
                        and existing_by_name != existing_by_ticker
                    ):
                        logger.warning(
                            "Skipping conflicting legacy shared mapping import for avanza_name=%s yahoo_ticker=%s",
                            avanza_name,
                            yahoo_ticker,
                        )
                        continue

                    target_id = existing_by_name or existing_by_ticker

                    if target_id is None:
                        conn.execute(text("""
                            INSERT INTO shared_ticker_mappings (
                                avanza_name,
                                yahoo_ticker,
                                instrument_id,
                                manually_added,
                                added_at
                            ) VALUES (
                                :avanza_name,
                                :yahoo_ticker,
                                :instrument_id,
                                :manually_added,
                                COALESCE(CAST(:added_at AS TIMESTAMPTZ), NOW())
                            )
                        """), {
                            "avanza_name": avanza_name,
                            "yahoo_ticker": yahoo_ticker,
                            "instrument_id": instrument_id,
                            "manually_added": manually_added,
                            "added_at": added_at,
                        })
                    else:
                        conn.execute(text("""
                            UPDATE shared_ticker_mappings
                            SET avanza_name = :avanza_name,
                                yahoo_ticker = :yahoo_ticker,
                                instrument_id = :instrument_id,
                                manually_added = :manually_added,
                                added_at = COALESCE(CAST(:added_at AS TIMESTAMPTZ), added_at)
                            WHERE id = :target_id
                        """), {
                            "target_id": target_id,
                            "avanza_name": avanza_name,
                            "yahoo_ticker": yahoo_ticker,
                            "instrument_id": instrument_id,
                            "manually_added": manually_added,
                            "added_at": added_at,
                        })

def get_db():
    """Create and yield a database session.
    
    Yields:
        Session: A SQLAlchemy database session.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db=Depends(get_db),
) -> User:
    """Resolve the active user from a validated bearer token."""
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Missing authentication token")

    try:
        user_id = verify_access_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token") from exc

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Unknown user for provided token")
    return user


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle events.
    
    Starts the scheduler on startup and stops it on shutdown.
    
    Args:
        app: The FastAPI application instance.
    
    Yields:
        None
    """
    from app.services.exchange_rate_service import close_session as close_exchange_rate_session
    from app.services.scheduler import start_scheduler, stop_scheduler
    validate_auth_token_secret()
    run_startup_schema_seed = os.getenv("RUN_STARTUP_SCHEMA_SEED", "1").lower() not in {"0", "false", "no"}
    if run_startup_schema_seed:
        try:
            ensure_account_schema_and_seed()
        except Exception:
            logger.exception("Startup schema/seed step failed")
            raise
    start_scheduler()
    logger.info("Application started")
    yield
    stop_scheduler()
    close_exchange_rate_session()
    logger.info("Application shutdown")


app = FastAPI(title="Stock Portfolio API", lifespan=lifespan)
DEFAULT_STATIC_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'static')
STATIC_DIR = os.getenv('BACKEND_STATIC_DIR') or os.getenv('STATIC_DIR') or DEFAULT_STATIC_DIR
STATIC_DIR_READY = os.path.isdir(STATIC_DIR)

if not STATIC_DIR_READY:
    try:
        os.makedirs(STATIC_DIR, exist_ok=True)
        STATIC_DIR_READY = True
    except OSError as exc:
        logger.warning("Unable to create static directory %s: %s. Static mounts disabled.", STATIC_DIR, exc)

if STATIC_DIR_READY:
    app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')
    app.mount('/api/static', StaticFiles(directory=STATIC_DIR), name='api-static')
else:
    logger.warning("Static directory unavailable at %s; skipping static file mounts", STATIC_DIR)

DEFAULT_FRONTEND_DIR = os.path.join(ROOT_DIR, 'frontend', 'dist')
FRONTEND_DIR = os.getenv('FRONTEND_STATIC_DIR') or os.getenv('FRONTEND_DIR') or DEFAULT_FRONTEND_DIR
FRONTEND_DIR_READY = os.path.isdir(FRONTEND_DIR)
FRONTEND_INDEX_PATH = os.path.join(FRONTEND_DIR, 'index.html')
FRONTEND_INDEX_READY = os.path.isfile(FRONTEND_INDEX_PATH)

if FRONTEND_DIR_READY and FRONTEND_INDEX_READY:
    logger.info("Frontend static files enabled from %s", FRONTEND_DIR)
elif FRONTEND_DIR_READY:
    logger.warning("Frontend directory %s found but index.html is missing.", FRONTEND_DIR)


def _resolve_frontend_path(request_path: str) -> Optional[str]:
    if not FRONTEND_DIR_READY:
        return None

    base = Path(FRONTEND_DIR).resolve()
    safe_request_path = request_path.lstrip("/")
    candidate = (base / safe_request_path).resolve()

    if candidate != base and base not in candidate.parents:
        return None

    if candidate.is_file():
        return str(candidate)

    return None


def _looks_like_frontend_file_request(request_path: str) -> bool:
    last_segment = Path(request_path).name.lower()
    if not last_segment:
        return False

    suffix = Path(last_segment).suffix.lower()
    return suffix in {
        ".css",
        ".gif",
        ".ico",
        ".jpeg",
        ".jpg",
        ".js",
        ".json",
        ".map",
        ".mjs",
        ".png",
        ".svg",
        ".txt",
        ".webp",
        ".woff",
        ".woff2",
    }


@app.middleware("http")
async def log_request_timing(request: Request, call_next):
    """
    Log timing for incoming HTTP requests under /api/ and emit warnings for slow requests or informational logs for selected tracked endpoints.
    
    Logs the request method, path, response status, and duration in milliseconds. If the duration is greater than or equal to REQUEST_TIMING_WARN_MS a warning is emitted; for specific tracked endpoints an informational log is emitted for normal-duration requests.
    
    Parameters:
        request (Request): The incoming FastAPI request.
        call_next (Callable): The ASGI call_next callable that processes the request and returns a Response.
    
    Returns:
        Response: The HTTP response produced by the next request handler.
    """
    start = time.perf_counter()
    status_code = 500

    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        duration_ms = (time.perf_counter() - start) * 1000
        path = request.url.path
        is_api_request = path.startswith("/api/")
        is_tracked_endpoint = (
            path.startswith("/api/finnhub/")
            or path.startswith("/api/marketstack/")
            or path.endswith("/dividends")
            or path.endswith("/upcoming-dividends")
            or path.endswith("/analyst")
        )

        if is_api_request:
            log_message = "API timing method=%s path=%s status=%s duration_ms=%.1f"
            if duration_ms >= REQUEST_TIMING_WARN_MS:
                logger.warning(log_message, request.method, path, status_code, duration_ms)
            elif is_tracked_endpoint:
                logger.info(log_message, request.method, path, status_code, duration_ms)


class StockCreate(BaseModel):
    ticker: str
    quantity: Optional[float] = None
    purchase_price: Optional[float] = None
    courtage: Optional[float] = None
    courtage_currency: Optional[str] = None
    exchange_rate: Optional[float] = None
    exchange_rate_currency: Optional[str] = None
    platform: Optional[str] = None
    purchase_date: Optional[date] = None
    position_entries: Optional[List[dict]] = None

    @model_validator(mode="after")
    def validate_create_payload(self) -> "StockCreate":
        has_position_entries = isinstance(self.position_entries, list) and len(self.position_entries) > 0

        if has_position_entries:
            return self

        if self.quantity is None:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "provide non-empty position_entries or a positive quantity."
            )

        if self.quantity <= 0:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "quantity must be greater than zero when position_entries is omitted."
            )

        if self.purchase_price is not None and self.purchase_price < 0:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "purchase_price must be greater than or equal to zero."
            )

        if self.courtage is not None and self.courtage < 0:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "courtage must be greater than or equal to zero."
            )

        if self.courtage and self.purchase_price is None:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "courtage requires purchase_price."
            )

        if self.courtage_currency is not None:
            normalized_currency = self.courtage_currency.strip().upper()
            if len(normalized_currency) != 3 or not normalized_currency.isalpha():
                raise ValueError(
                    "StockCreate validation failed for create_stock payload (/api/stocks): "
                    "courtage_currency must be a 3-letter currency code."
                )
            self.courtage_currency = normalized_currency

        if self.exchange_rate is not None and (not math.isfinite(self.exchange_rate) or self.exchange_rate <= 0):
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "exchange_rate must be greater than zero."
            )

        if self.exchange_rate is not None:
            if not self.exchange_rate_currency:
                raise ValueError(
                    "StockCreate validation failed for create_stock payload (/api/stocks): "
                    "exchange_rate requires exchange_rate_currency."
                )
            normalized_currency = self.exchange_rate_currency.strip().upper()
            if len(normalized_currency) != 3 or not normalized_currency.isalpha():
                raise ValueError(
                    "StockCreate validation failed for create_stock payload (/api/stocks): "
                    "exchange_rate_currency must be a 3-letter currency code."
                )
            self.exchange_rate_currency = normalized_currency
        elif self.exchange_rate_currency is not None:
            raise ValueError(
                "StockCreate validation failed for create_stock payload (/api/stocks): "
                "exchange_rate_currency requires exchange_rate."
            )

        if self.platform is not None:
            normalized_platform = self.platform.strip()
            if len(normalized_platform) > 100:
                raise ValueError(
                    "StockCreate validation failed for create_stock payload (/api/stocks): "
                    "platform must be 100 characters or fewer."
                )
            self.platform = normalized_platform or None

        return self


class StockUpdate(BaseModel):
    ticker: Optional[str] = None
    name: Optional[str] = None
    quantity: Optional[float] = None
    purchase_price: Optional[float] = None
    courtage: Optional[float] = None
    courtage_currency: Optional[str] = None
    exchange_rate: Optional[float] = None
    exchange_rate_currency: Optional[str] = None
    platform: Optional[str] = None
    purchase_date: Optional[date] = None
    position_entries: Optional[List[dict]] = None

    @model_validator(mode="after")
    def validate_update_payload(self) -> "StockUpdate":
        if self.ticker is not None:
            normalized_ticker = self.ticker.strip().upper()
            if not normalized_ticker:
                raise ValueError("ticker cannot be empty.")
            self.ticker = normalized_ticker

        if self.name is not None:
            normalized_name = self.name.strip()
            if len(normalized_name) > 255:
                raise ValueError("name must be 255 characters or fewer.")
            self.name = normalized_name or None

        if self.courtage_currency is not None:
            normalized_currency = self.courtage_currency.strip().upper()
            self.courtage_currency = normalized_currency or None
            if self.courtage_currency and (
                len(self.courtage_currency) != 3 or not self.courtage_currency.isalpha()
            ):
                raise ValueError("courtage_currency must be a 3-letter currency code.")

        if self.exchange_rate_currency is not None:
            self.exchange_rate_currency = self.exchange_rate_currency.strip().upper() or None

        if self.exchange_rate is not None and (not math.isfinite(self.exchange_rate) or self.exchange_rate <= 0):
            raise ValueError("exchange_rate must be greater than zero.")

        if self.exchange_rate is not None:
            if not self.exchange_rate_currency:
                raise ValueError("exchange_rate requires exchange_rate_currency.")
            if len(self.exchange_rate_currency) != 3 or not self.exchange_rate_currency.isalpha():
                raise ValueError("exchange_rate_currency must be a 3-letter currency code.")
        elif self.exchange_rate_currency is not None:
            raise ValueError("exchange_rate_currency requires exchange_rate.")

        if self.platform is not None:
            normalized_platform = self.platform.strip()
            if len(normalized_platform) > 100:
                raise ValueError("platform must be 100 characters or fewer.")
            self.platform = normalized_platform or None

        return self


class StockResponse(BaseModel):
    id: int
    ticker: str
    name: Optional[str]
    quantity: float
    currency: str
    sector: Optional[str]
    logo: Optional[str] = None
    purchase_price: Optional[float]
    purchase_date: Optional[date]
    position_entries: Optional[List[dict]] = []
    current_price: Optional[float]
    previous_close: Optional[float]
    dividend_yield: Optional[float]
    dividend_per_share: Optional[float]
    last_updated: Optional[datetime]
    manual_dividends: Optional[List[dict]] = []
    suppressed_dividends: Optional[List[dict]] = []

    @field_validator("last_updated", mode="before")
    @classmethod
    def ensure_last_updated_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        """
        Normalize a datetime to UTC.
        
        Converts a naive datetime by assigning the UTC timezone, and converts an aware datetime to the equivalent UTC time.
        
        Parameters:
            value (Optional[datetime]): The datetime to normalize; may be timezone-aware or naive.
        
        Returns:
            Optional[datetime]: The input converted to UTC, or None if input is None.
        """
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    class Config:
        from_attributes = True


class DividendCreate(BaseModel):
    stock_id: int
    amount: float
    currency: str
    ex_date: Optional[datetime] = None
    pay_date: Optional[datetime] = None


class DividendResponse(BaseModel):
    id: int
    stock_id: int
    amount: float
    currency: str
    ex_date: Optional[datetime]
    pay_date: Optional[datetime]

    class Config:
        from_attributes = True


class MarketIndex(BaseModel):
    symbol: str
    name: str
    price: float
    change: float
    change_percent: float


from app.services.stock_service import StockService
from app.routers import stocks, portfolio, market, finnhub, settings, marketstack, avanza, auth

stock_service = StockService()

app.include_router(stocks.router, prefix="/api/stocks", tags=["stocks"])
app.include_router(portfolio.router, prefix="/api/portfolio", tags=["portfolio"])
app.include_router(market.router, prefix="/api/market", tags=["market"])
app.include_router(finnhub.router, prefix="/api/finnhub", tags=["finnhub"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(marketstack.router, prefix="/api/marketstack", tags=["marketstack"])
app.include_router(avanza.router, prefix="/api/avanza", tags=["avanza"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])


@app.get("/")
def read_root():
    """Return API information.
    
    Returns:
        dict: A dictionary containing the API name and version.
    """
    if FRONTEND_INDEX_READY:
        return FileResponse(FRONTEND_INDEX_PATH)
    return {"message": "Stock Portfolio API", "version": "1.0.0"}


@app.get("/health")
def health_check():
    """Check API health status.
    
    Returns:
        dict: A dictionary containing the health status.
    """
    return {"status": "healthy"}


@app.get("/{full_path:path}")
def serve_frontend(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="Not Found")

    file_path = _resolve_frontend_path(full_path)
    if file_path:
        return FileResponse(file_path)

    if _looks_like_frontend_file_request(full_path):
        raise HTTPException(status_code=404, detail="Not Found")

    if FRONTEND_INDEX_READY:
        return FileResponse(FRONTEND_INDEX_PATH)

    raise HTTPException(status_code=404, detail="Not Found")
