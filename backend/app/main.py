"""Stock Portfolio Tracker API.

This module defines the FastAPI application, database models, Pydantic
schemas, and API routing configuration for the stock portfolio tracker.
"""

import os
import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional, Any
import logging

from fastapi import FastAPI, HTTPException, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from passlib.exc import UnknownHashError
from pydantic import BaseModel, field_validator
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey, JSON, Boolean, text, UniqueConstraint
from sqlalchemy.orm import sessionmaker, relationship, declarative_base
from sqlalchemy.pool import NullPool
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

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


def validate_startup_env() -> None:
    """Validate required security-sensitive environment variables."""
    required = ["DEFAULT_USERNAME", "DEFAULT_PASSWORD", "GUEST_USERNAME", "AUTH_TOKEN_SECRET"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(f"Missing required environment variables: {joined}")


def create_access_token(user_id: int) -> str:
    """Create a signed bearer token for a specific user id."""
    secret = _get_required_env("AUTH_TOKEN_SECRET")
    ttl_seconds = int(os.getenv("AUTH_TOKEN_TTL_SECONDS", "43200"))
    payload = {
        "sub": user_id,
        "exp": int(time.time()) + ttl_seconds,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = _b64url_encode(payload_bytes)
    signature = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    signature_b64 = _b64url_encode(signature)
    return f"{payload_b64}.{signature_b64}"


def verify_access_token(token: str) -> int:
    """Validate a bearer token and return the canonical user id."""
    secret = _get_required_env("AUTH_TOKEN_SECRET")
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
        ticker: Stock ticker symbol (unique).
        name: Company name.
        quantity: Number of shares owned.
        currency: Trading currency (default 'USD').
        sector: Company sector.
        logo: URL to company logo image.
        purchase_price: Average purchase price per share.
        current_price: Current market price.
        previous_close: Previous day's closing price.
        dividend_yield: Annual dividend yield percentage.
        dividend_per_share: Annual dividend per share.
        last_updated: Timestamp of last data refresh.
        manual_dividends: List of manually recorded dividends.
        suppressed_dividends: List of suppressed broker dividends.
    """
    __tablename__ = "stocks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=True)
    ticker = Column(String, unique=True, index=True, nullable=False)
    name = Column(String)
    quantity = Column(Float, default=0)
    currency = Column(String, default="USD")
    sector = Column(String)
    logo = Column(String, nullable=True)
    purchase_price = Column(Float, nullable=True)
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
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=True)
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

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=True)
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
    """
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=True)
    display_currency = Column(String, default="SEK")
    header_indices = Column(String, default="[]")


Base.metadata.create_all(bind=engine)


def ensure_account_schema_and_seed() -> None:
    """Backfill auth-related schema and seed default/guest users with demo data."""
    validate_startup_env()

    default_username = _get_required_env("DEFAULT_USERNAME")
    default_password = _get_required_env("DEFAULT_PASSWORD")
    guest_username = _get_required_env("GUEST_USERNAME")
    guest_password = os.getenv("GUEST_PASSWORD") or secrets.token_urlsafe(24)

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
        conn.execute(text("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("ALTER TABLE portfolio_history ADD COLUMN IF NOT EXISTS user_id INTEGER"))
        conn.execute(text("ALTER TABLE stock_price_history ADD COLUMN IF NOT EXISTS user_id INTEGER"))

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
        guest_user_id = conn.execute(
            text("SELECT id FROM users WHERE username = :username"),
            {"username": guest_username},
        ).scalar_one()

        conn.execute(text("UPDATE stocks SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE user_settings SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE portfolio_history SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})
        conn.execute(text("UPDATE stock_price_history SET user_id = :uid WHERE user_id IS NULL"), {"uid": default_user_id})

        conn.execute(text("UPDATE stocks SET user_id = :uid WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)"), {"uid": default_user_id})
        conn.execute(text("UPDATE user_settings SET user_id = :uid WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)"), {"uid": default_user_id})
        conn.execute(text("UPDATE portfolio_history SET user_id = :uid WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)"), {"uid": default_user_id})
        conn.execute(text("UPDATE stock_price_history SET user_id = :uid WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)"), {"uid": default_user_id})

        conn.execute(text("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
                    WHERE c.contype = 'f' AND t.relname = 'stocks' AND a.attname = 'user_id'
                ) THEN
                    ALTER TABLE stocks
                    ADD CONSTRAINT fk_stocks_user_id_users
                    FOREIGN KEY (user_id) REFERENCES users(id);
                END IF;
            END $$;
        """))
        conn.execute(text("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
                    WHERE c.contype = 'f' AND t.relname = 'user_settings' AND a.attname = 'user_id'
                ) THEN
                    ALTER TABLE user_settings
                    ADD CONSTRAINT fk_user_settings_user_id_users
                    FOREIGN KEY (user_id) REFERENCES users(id);
                END IF;
            END $$;
        """))
        conn.execute(text("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
                    WHERE c.contype = 'f' AND t.relname = 'portfolio_history' AND a.attname = 'user_id'
                ) THEN
                    ALTER TABLE portfolio_history
                    ADD CONSTRAINT fk_portfolio_history_user_id_users
                    FOREIGN KEY (user_id) REFERENCES users(id);
                END IF;
            END $$;
        """))
        conn.execute(text("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
                    WHERE c.contype = 'f' AND t.relname = 'stock_price_history' AND a.attname = 'user_id'
                ) THEN
                    ALTER TABLE stock_price_history
                    ADD CONSTRAINT fk_stock_price_history_user_id_users
                    FOREIGN KEY (user_id) REFERENCES users(id);
                END IF;
            END $$;
        """))

        conn.execute(text("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stocks_ticker_key') THEN ALTER TABLE stocks DROP CONSTRAINT stocks_ticker_key; END IF; END $$;"))
        conn.execute(text("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_history_date_key') THEN ALTER TABLE portfolio_history DROP CONSTRAINT portfolio_history_date_key; END IF; END $$;"))

        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_stocks_user_ticker ON stocks(user_id, ticker)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_portfolio_history_user_date ON portfolio_history(user_id, date)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stock_price_history_user_ticker ON stock_price_history(user_id, ticker)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_user_settings_user_id ON user_settings(user_id)"))

        guest_stock_count = conn.execute(
            text("SELECT COUNT(*) FROM stocks WHERE user_id = :uid"),
            {"uid": guest_user_id},
        ).scalar_one()
        if guest_stock_count == 0:
            now = utc_now()
            guest_stocks = [
                {
                    "ticker": "VOLV-B.ST",
                    "name": "Volvo B",
                    "quantity": 28.0,
                    "currency": "SEK",
                    "sector": "Industrials",
                    "purchase_price": 245.0,
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
                    "current_price": 174.9,
                    "previous_close": 174.0,
                    "dividend_yield": 1.6,
                    "dividend_per_share": 2.2,
                },
            ]
            for stock in guest_stocks:
                conn.execute(text("""
                    INSERT INTO stocks (
                        user_id, ticker, name, quantity, currency, sector, purchase_price,
                        current_price, previous_close, dividend_yield, dividend_per_share,
                        last_updated, manual_dividends, suppressed_dividends
                    ) VALUES (
                        :user_id, :ticker, :name, :quantity, :currency, :sector, :purchase_price,
                        :current_price, :previous_close, :dividend_yield, :dividend_per_share,
                        :last_updated, '[]'::json, '[]'::json
                    )
                """), {
                    "user_id": guest_user_id,
                    "ticker": stock["ticker"],
                    "name": stock["name"],
                    "quantity": stock["quantity"],
                    "currency": stock["currency"],
                    "sector": stock["sector"],
                    "purchase_price": stock["purchase_price"],
                    "current_price": stock["current_price"],
                    "previous_close": stock["previous_close"],
                    "dividend_yield": stock["dividend_yield"],
                    "dividend_per_share": stock["dividend_per_share"],
                    "last_updated": now,
                })


ensure_account_schema_and_seed()


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
    from app.services.scheduler import start_scheduler, stop_scheduler
    start_scheduler()
    logger.info("Application started")
    yield
    stop_scheduler()
    logger.info("Application shutdown")


app = FastAPI(title="Stock Portfolio API", lifespan=lifespan)


class StockCreate(BaseModel):
    ticker: str
    quantity: float
    purchase_price: Optional[float] = None


class StockUpdate(BaseModel):
    quantity: Optional[float] = None
    purchase_price: Optional[float] = None


class StockResponse(BaseModel):
    id: int
    ticker: str
    name: Optional[str]
    quantity: float
    currency: str
    sector: Optional[str]
    logo: Optional[str] = None
    purchase_price: Optional[float]
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
    return {"message": "Stock Portfolio API", "version": "1.0.0"}


@app.get("/health")
def health_check():
    """Check API health status.
    
    Returns:
        dict: A dictionary containing the health status.
    """
    return {"status": "healthy"}
