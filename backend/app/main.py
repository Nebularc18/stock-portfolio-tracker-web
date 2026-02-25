import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Optional, Any
import logging

from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey, JSON
from sqlalchemy.orm import sessionmaker, relationship, declarative_base
from sqlalchemy.pool import NullPool

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://portfolio:portfolio@localhost:5432/portfolio")

engine = create_engine(DATABASE_URL, poolclass=NullPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Stock(Base):
    __tablename__ = "stocks"

    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, unique=True, index=True, nullable=False)
    name = Column(String)
    quantity = Column(Float, default=0)
    currency = Column(String, default="USD")
    sector = Column(String)
    purchase_price = Column(Float, nullable=True)
    current_price = Column(Float, nullable=True)
    previous_close = Column(Float, nullable=True)
    dividend_yield = Column(Float, nullable=True)
    dividend_per_share = Column(Float, nullable=True)
    last_updated = Column(DateTime, default=datetime.utcnow)
    manual_dividends = Column(JSON, default=list)
    suppressed_dividends = Column(JSON, default=list)

    dividends = relationship("Dividend", back_populates="stock")


class Dividend(Base):
    __tablename__ = "dividends"

    id = Column(Integer, primary_key=True, index=True)
    stock_id = Column(Integer, ForeignKey("stocks.id"))
    amount = Column(Float)
    currency = Column(String)
    ex_date = Column(DateTime, nullable=True)
    pay_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    stock = relationship("Stock", back_populates="dividends")


class PortfolioHistory(Base):
    __tablename__ = "portfolio_history"

    id = Column(Integer, primary_key=True, index=True)
    total_value = Column(Float)
    date = Column(DateTime, default=datetime.utcnow)


class StockPriceHistory(Base):
    __tablename__ = "stock_price_history"

    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, index=True, nullable=False)
    price = Column(Float, nullable=False)
    currency = Column(String, nullable=False)
    recorded_at = Column(DateTime, default=datetime.utcnow, index=True)


class UserSettings(Base):
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, index=True)
    display_currency = Column(String, default="SEK")


Base.metadata.create_all(bind=engine)


def get_db():
    """
    Yield a SQLAlchemy database session for use as a dependency.
    
    This generator provides a SessionLocal instance to callers and guarantees the session is closed after use.
    
    Returns:
        db (Session): A SQLAlchemy Session instance that will be closed automatically when the dependency scope ends.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application lifespan by starting the background scheduler on startup and stopping it on shutdown.
    
    Calls start_scheduler() before yielding control to the application and calls stop_scheduler() after shutdown; logs both lifecycle events.
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
    purchase_price: Optional[float]
    current_price: Optional[float]
    previous_close: Optional[float]
    dividend_yield: Optional[float]
    dividend_per_share: Optional[float]
    last_updated: Optional[datetime]
    manual_dividends: Optional[List[dict]] = []
    suppressed_dividends: Optional[List[dict]] = []

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
from app.routers import stocks, portfolio, market, finnhub, settings

stock_service = StockService()

app.include_router(stocks.router, prefix="/api/stocks", tags=["stocks"])
app.include_router(portfolio.router, prefix="/api/portfolio", tags=["portfolio"])
app.include_router(market.router, prefix="/api/market", tags=["market"])
app.include_router(finnhub.router, prefix="/api/finnhub", tags=["finnhub"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])


@app.get("/")
def read_root():
    return {"message": "Stock Portfolio API", "version": "1.0.0"}


@app.get("/health")
def health_check():
    """
    Return a minimal health status payload for the service.
    
    Returns:
        dict: A JSON-serializable mapping with a single key "status" set to "healthy".
    """
    return {"status": "healthy"}
