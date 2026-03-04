"""Stock portfolio API endpoints.

This module provides API endpoints for managing stocks in a portfolio,
including CRUD operations, dividend tracking, and analyst data.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import uuid
import logging

from app.main import get_db, Stock, StockCreate, StockUpdate, StockResponse, StockPriceHistory

router = APIRouter()
logger = logging.getLogger(__name__)


class ManualDividendCreate(BaseModel):
    date: str
    amount: float
    currency: Optional[str] = None
    note: Optional[str] = None


class ManualDividendUpdate(BaseModel):
    date: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[str] = None
    note: Optional[str] = None


@router.get("", response_model=list[StockResponse])
def get_stocks(db: Session = Depends(get_db)):
    """Retrieve all stocks in the portfolio.
    
    Args:
        db: Database session dependency.
    
    Returns:
        list[StockResponse]: List of all stocks.
    """
    stocks = db.query(Stock).all()
    return stocks


@router.get("/validate/{ticker}")
def validate_ticker(ticker: str):
    """Validate a stock ticker symbol.
    
    Args:
        ticker: The stock ticker symbol to validate.
    
    Returns:
        dict: Validation result with 'valid', 'name', and 'currency' fields.
    
    Raises:
        HTTPException: 404 if ticker is invalid.
    """
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    ticker = ticker.upper()
    is_valid = stock_service.validate_ticker(ticker)
    if not is_valid:
        raise HTTPException(status_code=404, detail="Invalid ticker symbol")
    
    info = stock_service.get_stock_info(ticker)
    return {
        "valid": True,
        "name": info.get("name") if info else None,
        "currency": info.get("currency") if info else None,
    }


@router.get("/{ticker}", response_model=StockResponse)
def get_stock(ticker: str, db: Session = Depends(get_db)):
    """Retrieve a single stock by ticker symbol.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        StockResponse: The stock data.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    return stock


@router.post("", response_model=StockResponse)
def create_stock(stock_data: StockCreate, db: Session = Depends(get_db)):
    """Add a new stock to the portfolio.
    
    Args:
        stock_data: Stock creation data (ticker, quantity, purchase_price).
        db: Database session dependency.
    
    Returns:
        StockResponse: The created stock.
    
    Raises:
        HTTPException: 400 if stock already exists or ticker is invalid.
    """
    from app.services.stock_service import StockService
    from app.services.brandfetch_service import brandfetch_service
    stock_service = StockService()
    
    ticker = stock_data.ticker.upper()
    logger.info(f"Attempting to add stock: {ticker}")
    
    existing = db.query(Stock).filter(Stock.ticker == ticker).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Stock {ticker} already exists in portfolio")
    
    is_valid = stock_service.validate_ticker(ticker)
    logger.info(f"Ticker {ticker} validation result: {is_valid}")
    
    if not is_valid:
        raise HTTPException(status_code=400, detail=f"Invalid ticker symbol '{ticker}'. Could not find stock data. Try a different symbol or check if the market is open.")
    
    info = stock_service.get_stock_info(ticker)
    logger.info(f"Stock info for {ticker}: {info}")
    
    if not info:
        raise HTTPException(status_code=400, detail=f"Could not fetch stock information for '{ticker}'. Please try again.")
    
    logo = brandfetch_service.get_logo_url_for_ticker(ticker, info.get("name"))
    
    stock = Stock(
        ticker=ticker,
        name=info.get("name"),
        quantity=stock_data.quantity,
        currency=info.get("currency", "USD"),
        sector=info.get("sector"),
        logo=logo,
        purchase_price=stock_data.purchase_price,
        current_price=info.get("current_price"),
        previous_close=info.get("previous_close"),
        dividend_yield=info.get("dividend_yield"),
        dividend_per_share=info.get("dividend_per_share"),
        last_updated=datetime.utcnow(),
    )
    
    db.add(stock)
    db.commit()
    db.refresh(stock)
    logger.info(f"Successfully added stock: {ticker}")
    return stock


@router.patch("/{ticker}", response_model=StockResponse)
def update_stock(ticker: str, stock_data: StockUpdate, db: Session = Depends(get_db)):
    """Update a stock's quantity or purchase price.
    
    Args:
        ticker: The stock ticker symbol.
        stock_data: Stock update data (quantity, purchase_price).
        db: Database session dependency.
    
    Returns:
        StockResponse: The updated stock.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    if stock_data.quantity is not None:
        stock.quantity = stock_data.quantity
    if stock_data.purchase_price is not None:
        stock.purchase_price = stock_data.purchase_price
    
    db.commit()
    db.refresh(stock)
    return stock


@router.delete("/{ticker}")
def delete_stock(ticker: str, db: Session = Depends(get_db)):
    """Remove a stock from the portfolio.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        dict: Confirmation message.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    db.delete(stock)
    db.commit()
    return {"message": "Stock deleted"}


@router.post("/{ticker}/refresh")
def refresh_stock(ticker: str, db: Session = Depends(get_db)):
    """Refresh stock data from external sources.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        StockResponse: The updated stock with fresh data.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    from app.services.stock_service import StockService
    from app.services.brandfetch_service import brandfetch_service
    stock_service = StockService()
    
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    info = stock_service.get_stock_info(ticker)
    if info:
        stock.name = info.get("name") or stock.name
        stock.current_price = info.get("current_price")
        stock.previous_close = info.get("previous_close")
        stock.dividend_yield = info.get("dividend_yield")
        stock.dividend_per_share = info.get("dividend_per_share")
        stock.sector = info.get("sector") or stock.sector
        stock.last_updated = datetime.utcnow()
        
        should_refresh_logo = (not stock.logo) or ('cdn.brandfetch.io' in stock.logo)
        if should_refresh_logo:
            refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
                stock.ticker,
                stock.name or info.get("name"),
                force_refresh=True,
            )
            if refreshed_logo:
                stock.logo = refreshed_logo
        
        db.commit()
        db.refresh(stock)
    
    return stock


@router.get("/{ticker}/dividends")
def get_stock_dividends(ticker: str, years: int = 5, db: Session = Depends(get_db)):
    """Retrieve dividend history for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        years: Number of years of history to retrieve (default 5).
        db: Database session dependency.
    
    Returns:
        list: List of dividend records with dates and amounts.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    dividends = stock_service.get_dividends(ticker, years)
    return dividends


@router.get("/{ticker}/upcoming-dividends")
def get_upcoming_dividends(ticker: str, db: Session = Depends(get_db)):
    """Retrieve upcoming dividend dates for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        list: List of upcoming dividend events.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    upcoming = stock_service.get_upcoming_dividends(ticker)
    return upcoming or []


@router.get("/{ticker}/analyst")
def get_analyst_data(ticker: str, db: Session = Depends(get_db)):
    """Retrieve analyst recommendations and price targets for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        dict: Contains recommendations, finnhub_recommendations,
            price_targets, and latest_rating.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    all_recommendations = stock_service.get_all_analyst_recommendations(ticker)
    price_targets = stock_service.get_price_targets(ticker)
    latest_rating = stock_service.get_latest_rating(ticker)
    
    return {
        "recommendations": all_recommendations.get('yfinance'),
        "finnhub_recommendations": all_recommendations.get('finnhub'),
        "price_targets": price_targets,
        "latest_rating": latest_rating,
    }


@router.post("/{ticker}/manual-dividends", response_model=StockResponse)
def add_manual_dividend(ticker: str, dividend_data: ManualDividendCreate, db: Session = Depends(get_db)):
    """Add a manually recorded dividend for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        dividend_data: Dividend details (date, amount, currency, note).
        db: Database session dependency.
    
    Returns:
        StockResponse: Updated stock with new manual dividend.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    manual_divs = stock.manual_dividends or []
    new_dividend = {
        "id": str(uuid.uuid4()),
        "date": dividend_data.date,
        "amount": dividend_data.amount,
        "currency": dividend_data.currency or stock.currency,
        "note": dividend_data.note or "",
        "added_at": datetime.utcnow().isoformat(),
    }
    manual_divs.append(new_dividend)
    stock.manual_dividends = manual_divs
    
    db.commit()
    db.refresh(stock)
    return stock


@router.put("/{ticker}/manual-dividends/{dividend_id}", response_model=StockResponse)
def update_manual_dividend(
    ticker: str, 
    dividend_id: str, 
    dividend_data: ManualDividendUpdate, 
    db: Session = Depends(get_db)
):
    """Update a manually recorded dividend.
    
    Args:
        ticker: The stock ticker symbol.
        dividend_id: UUID of the dividend to update.
        dividend_data: Fields to update (date, amount, currency, note).
        db: Database session dependency.
    
    Returns:
        StockResponse: Updated stock with modified dividend.
    
    Raises:
        HTTPException: 404 if stock or dividend not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    manual_divs = stock.manual_dividends or []
    found = False
    for div in manual_divs:
        if div.get("id") == dividend_id:
            if dividend_data.date is not None:
                div["date"] = dividend_data.date
            if dividend_data.amount is not None:
                div["amount"] = dividend_data.amount
            if dividend_data.currency is not None:
                div["currency"] = dividend_data.currency
            if dividend_data.note is not None:
                div["note"] = dividend_data.note
            div["updated_at"] = datetime.utcnow().isoformat()
            found = True
            break
    
    if not found:
        raise HTTPException(status_code=404, detail="Dividend not found")
    
    stock.manual_dividends = manual_divs
    db.commit()
    db.refresh(stock)
    return stock


@router.delete("/{ticker}/manual-dividends/{dividend_id}")
def delete_manual_dividend(ticker: str, dividend_id: str, db: Session = Depends(get_db)):
    """Delete a manually recorded dividend.
    
    Args:
        ticker: The stock ticker symbol.
        dividend_id: UUID of the dividend to delete.
        db: Database session dependency.
    
    Returns:
        dict: Confirmation message.
    
    Raises:
        HTTPException: 404 if stock or dividend not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    manual_divs = stock.manual_dividends or []
    filtered_divs = [d for d in manual_divs if d.get("id") != dividend_id]
    
    if len(filtered_divs) == len(manual_divs):
        raise HTTPException(status_code=404, detail="Dividend not found")
    
    stock.manual_dividends = filtered_divs
    db.commit()
    return {"message": "Dividend deleted"}


class SuppressDividendCreate(BaseModel):
    date: str
    amount: Optional[float] = None
    currency: Optional[str] = None


@router.post("/{ticker}/suppress-dividend")
def suppress_broker_dividend(ticker: str, data: SuppressDividendCreate, db: Session = Depends(get_db)):
    """Suppress a broker-reported dividend from dividend calculations.
    
    Args:
        ticker: The stock ticker symbol.
        data: Suppression details (date, amount, currency).
        db: Database session dependency.
    
    Returns:
        dict: Confirmation message with suppression details.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    suppressed = stock.suppressed_dividends or []
    
    for s in suppressed:
        if s.get("date") == data.date:
            return {"message": "Dividend already suppressed"}
    
    suppression = {
        "id": str(uuid.uuid4()),
        "date": data.date,
        "amount": data.amount,
        "currency": data.currency or stock.currency,
        "suppressed_at": datetime.utcnow().isoformat(),
    }
    suppressed.append(suppression)
    stock.suppressed_dividends = suppressed
    
    db.commit()
    return {"message": "Dividend suppressed", "suppression": suppression}


@router.delete("/{ticker}/suppress-dividend/{date}")
def restore_broker_dividend(ticker: str, date: str, db: Session = Depends(get_db)):
    """Restore a previously suppressed broker dividend.
    
    Args:
        ticker: The stock ticker symbol.
        date: Date of the dividend suppression to remove.
        db: Database session dependency.
    
    Returns:
        dict: Confirmation message.
    
    Raises:
        HTTPException: 404 if stock or suppression not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    suppressed = stock.suppressed_dividends or []
    filtered = [s for s in suppressed if s.get("date") != date]
    
    if len(filtered) == len(suppressed):
        raise HTTPException(status_code=404, detail="Suppression not found")
    
    stock.suppressed_dividends = filtered
    db.commit()
    return {"message": "Dividend restored"}


@router.get("/{ticker}/suppressed-dividends")
def get_suppressed_dividends(ticker: str, db: Session = Depends(get_db)):
    """Retrieve all suppressed dividends for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        list: List of suppressed dividend records.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(Stock.ticker == ticker.upper()).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    return stock.suppressed_dividends or []


@router.get("/{ticker}/price-history")
def get_stock_price_history(ticker: str, days: int = 30, db: Session = Depends(get_db)):
    """Retrieve historical price data for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        days: Number of days of history to retrieve (default 30).
        db: Database session dependency.
    
    Returns:
        list: List of price records with date, price, and currency.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    ticker_upper = ticker.upper()
    stock = db.query(Stock).filter(Stock.ticker == ticker_upper).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    from datetime import timedelta
    start_date = datetime.utcnow() - timedelta(days=days)
    
    history = db.query(StockPriceHistory).filter(
        StockPriceHistory.ticker == ticker_upper,
        StockPriceHistory.recorded_at >= start_date
    ).order_by(StockPriceHistory.recorded_at.asc()).all()
    
    return [{
        "date": h.recorded_at.isoformat(),
        "price": h.price,
        "currency": h.currency
    } for h in history]
