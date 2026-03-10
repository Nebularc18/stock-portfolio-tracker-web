"""Stock portfolio API endpoints.

This module provides API endpoints for managing stocks in a portfolio,
including CRUD operations, dividend tracking, and analyst data.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import uuid
import logging
from datetime import date

from app.main import get_db, get_current_user, User, Stock, StockCreate, StockUpdate, StockResponse, StockPriceHistory
from app.utils.time import utc_now

router = APIRouter()
logger = logging.getLogger(__name__)
MAX_BATCH_TICKERS = 25
MAX_YEARS = 10


def _is_on_or_after_purchase_date(event_date: Optional[str], purchase_date: Optional[date]) -> bool:
    """
    Determine whether an event date is on or after the given purchase date; if either date is missing, treat it as valid.
    
    Parameters:
        event_date (Optional[str]): Event date as an ISO-formatted string (YYYY-MM-DD) or None/empty.
        purchase_date (Optional[date]): Purchase date as a date object or None.
    
    Returns:
        bool: `true` if `purchase_date` is None or `event_date` is missing, or if `event_date` is the same as or after `purchase_date`; `false` otherwise.
    """
    if purchase_date is None or not event_date:
        return True
    try:
        event_date_value = date.fromisoformat(event_date)
    except ValueError:
        return event_date > purchase_date.isoformat()
    return event_date_value > purchase_date


def _get_merged_stock_dividends(stock: Stock, ticker: str, years: int, stock_service, avanza_service) -> list[dict]:
    """
    Builds a merged, deduplicated list of dividend records for a stock by combining local service dividends and Avanza-derived dividends.
    
    The result excludes any dividend dated before the stock's purchase_date, prefers Avanza-provided records and entries that include `payment_date` or `dividend_type` when de-duplicating, and is sorted by `date` descending.
    
    Parameters:
        stock (Stock): The stock model whose purchase_date and currency are used to filter and normalize dividends.
        ticker (str): The stock ticker to fetch Avanza dividends for.
        years (int): Number of years of historical dividends to include from both sources.
    
    Returns:
        merged_dividends (list[dict]): List of dividend records where each dict includes at least `date`, `amount`, and `currency`, and may include `source`, `payment_date`, and `dividend_type`.
    """
    dividends_raw = stock_service.get_dividends(ticker, years)
    dividends = [
        div for div in (dividends_raw or [])
        if _is_on_or_after_purchase_date(div.get('date'), stock.purchase_date)
    ]
    mapped_year_dividends = []

    avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        current_year = utc_now().year
        for year in range(current_year - years + 1, current_year + 1):
            year_dividends = avanza_service.get_stock_dividends_for_year(ticker, year) or []
            for div in year_dividends:
                mapped_year_dividends.append({
                    'date': div.ex_date,
                    'amount': div.amount,
                    'currency': div.currency,
                    'source': 'avanza',
                    'payment_date': div.payment_date,
                    'dividend_type': div.dividend_type,
                })

    mapped_year_dividends = [
        div for div in mapped_year_dividends
        if _is_on_or_after_purchase_date(div.get('date'), stock.purchase_date)
    ]

    deduped = {}
    for div in [*dividends, *mapped_year_dividends]:
        normalized_currency = div.get('currency') or stock.currency or ''
        key = (
            div.get('date') or '',
            div.get('amount'),
            normalized_currency,
        )
        existing = deduped.get(key)
        if existing is None:
            if not div.get('currency'):
                div = {**div, 'currency': stock.currency}
            deduped[key] = div
            continue

        existing_score = int(bool(existing.get('payment_date'))) + int(bool(existing.get('dividend_type'))) + (2 if existing.get('source') == 'avanza' else 0)
        candidate = div if div.get('currency') else {**div, 'currency': stock.currency}
        candidate_score = int(bool(candidate.get('payment_date'))) + int(bool(candidate.get('dividend_type'))) + (2 if candidate.get('source') == 'avanza' else 0)
        if candidate_score >= existing_score:
            deduped[key] = candidate

    merged_dividends = list(deduped.values())
    merged_dividends.sort(key=lambda item: item.get('date') or '', reverse=True)
    return merged_dividends

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
def get_stocks(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Retrieve all stocks in the portfolio.
    
    Args:
        db: Database session dependency.
    
    Returns:
        list[StockResponse]: List of all stocks.
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    return stocks


@router.get("/validate/{ticker}")
def validate_ticker(ticker: str):
    """
    Check whether a stock ticker symbol is valid and return basic stock information.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
    
    Returns:
        dict: Mapping with keys:
            - "valid": `True` if the ticker is valid.
            - "name": Company name if available, otherwise `None`.
            - "currency": Currency code if available, otherwise `None`.
    
    Raises:
        HTTPException: 404 if the ticker is invalid.
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


@router.get("/dividends/batch")
def get_stock_dividends_batch(
    tickers: list[str] = Query(...),
    years: int = 5,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return merged dividend histories for a batch of tickers owned by the current user.
    
    Parameters:
        tickers (list[str]): Iterable of ticker symbols to fetch; values are normalized (trimmed, uppercased) and deduplicated.
        years (int): Number of years of dividend history to include (must be between 1 and 10).
    
    Returns:
        dict: Mapping from ticker (str) to a list of merged dividend records for that ticker.
    
    Raises:
        HTTPException: 400 if no tickers provided, if more than the allowed unique tickers are supplied, or if `years` is out of allowed range; 404 if any requested ticker is not found for the current user.
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service

    stock_service = StockService()

    normalized_tickers = []
    seen_tickers = set()
    for ticker in tickers:
        normalized_ticker = ticker.strip().upper()
        if not normalized_ticker:
            continue
        if normalized_ticker in seen_tickers:
            continue
        seen_tickers.add(normalized_ticker)
        normalized_tickers.append(normalized_ticker)

    if not normalized_tickers:
        raise HTTPException(status_code=400, detail="At least one ticker is required")
    if len(normalized_tickers) > MAX_BATCH_TICKERS:
        raise HTTPException(
            status_code=400,
            detail=f"A maximum of {MAX_BATCH_TICKERS} unique tickers is allowed per batch request",
        )
    if years < 1 or years > MAX_YEARS:
        raise HTTPException(
            status_code=400,
            detail=f"years must be between 1 and {MAX_YEARS}",
        )

    stocks = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker.in_(normalized_tickers),
    ).all()
    stocks_by_ticker = {stock.ticker: stock for stock in stocks}

    missing_tickers = [ticker for ticker in normalized_tickers if ticker not in stocks_by_ticker]
    if missing_tickers:
        raise HTTPException(status_code=404, detail=f"Stocks not found: {', '.join(missing_tickers)}")

    return {
        ticker: _get_merged_stock_dividends(stocks_by_ticker[ticker], ticker, years, stock_service, avanza_service)
        for ticker in normalized_tickers
    }


@router.get("/{ticker}", response_model=StockResponse)
def get_stock(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Retrieve the stock record for the current user matching the given ticker symbol.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
    
    Returns:
        The Stock record matching the ticker for the current user.
    
    Raises:
        HTTPException: 404 if no matching stock is found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    return stock


@router.post("", response_model=StockResponse)
def create_stock(stock_data: StockCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Create and persist a new stock record in the portfolio.
    
    Validates the provided ticker, fetches market metadata and a logo, sets timestamps, and saves the new Stock to the database.
    
    Parameters:
        stock_data (StockCreate): Creation data containing at least `ticker`, `quantity`, and `purchase_price`.
    
    Returns:
        Stock: The newly created stock record.
    
    Raises:
        HTTPException: 400 if the stock already exists, the ticker is invalid, or stock information could not be retrieved.
    """
    from app.services.stock_service import StockService
    from app.services.brandfetch_service import brandfetch_service
    stock_service = StockService()
    
    ticker = stock_data.ticker.upper()
    logger.info(f"Attempting to add stock: {ticker}")
    
    existing = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker,
    ).first()
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
        user_id=current_user.id,
        ticker=ticker,
        name=info.get("name"),
        quantity=stock_data.quantity,
        currency=info.get("currency", "USD"),
        sector=info.get("sector"),
        logo=logo,
        purchase_price=stock_data.purchase_price,
        purchase_date=stock_data.purchase_date,
        current_price=info.get("current_price"),
        previous_close=info.get("previous_close"),
        dividend_yield=info.get("dividend_yield"),
        dividend_per_share=info.get("dividend_per_share"),
        last_updated=utc_now(),
    )
    
    db.add(stock)
    db.commit()
    db.refresh(stock)
    logger.info(f"Successfully added stock: {ticker}")
    return stock


@router.patch("/{ticker}", response_model=StockResponse)
def update_stock(ticker: str, stock_data: StockUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Update a stock's quantity, purchase price, and optionally its purchase date.
    
    Parameters:
        ticker (str): Stock ticker symbol to update.
        stock_data (StockUpdate): Fields to update; if `purchase_date` is present in the payload it will be applied.
    
    Returns:
        StockResponse: The updated stock record.
    
    Raises:
        HTTPException: 404 if the stock for the current user and ticker is not found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    if stock_data.quantity is not None:
        stock.quantity = stock_data.quantity
    if stock_data.purchase_price is not None:
        stock.purchase_price = stock_data.purchase_price
    provided_fields = getattr(stock_data, "model_fields_set", getattr(stock_data, "__fields_set__", set()))
    if "purchase_date" in provided_fields:
        stock.purchase_date = stock_data.purchase_date
    
    db.commit()
    db.refresh(stock)
    return stock


@router.delete("/{ticker}")
def delete_stock(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Remove a stock from the portfolio.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        dict: Confirmation message.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    db.delete(stock)
    db.commit()
    return {"message": "Stock deleted"}


@router.post("/{ticker}/refresh")
def refresh_stock(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Refreshes a stock's data from external sources and persists any updates.
    
    Parameters:
        ticker (str): Stock ticker symbol; case-insensitive.
    
    Returns:
        Stock: The updated Stock ORM instance with refreshed fields, or the existing stock unchanged if no external info was returned.
    
    Raises:
        HTTPException: 404 if the stock does not exist.
    """
    from app.services.stock_service import StockService
    from app.services.brandfetch_service import brandfetch_service
    stock_service = StockService()
    
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
        stock.last_updated = utc_now()
        
        should_refresh_logo = not stock.logo
        if should_refresh_logo:
            refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
                stock.ticker,
                stock.name or info.get("name"),
                force_refresh=False,
            )
            if refreshed_logo:
                stock.logo = refreshed_logo
        
        db.commit()
        db.refresh(stock)
    
    return stock


@router.get("/{ticker}/dividends")
def get_stock_dividends(ticker: str, years: int = 5, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Retrieve merged dividend history for the given stock ticker over the specified number of years.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
        years (int): Number of years of history to include (default 5).
    
    Returns:
        list: Merged, deduplicated list of dividend records sorted by date descending. Each record includes date, amount, currency, and source metadata.
    
    Raises:
        HTTPException: 404 if the stock is not found for the current user.
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service
    stock_service = StockService()
    
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")

    if years < 1 or years > MAX_YEARS:
        raise HTTPException(
            status_code=400,
            detail=f"years must be between 1 and {MAX_YEARS}",
        )

    return _get_merged_stock_dividends(stock, ticker, years, stock_service, avanza_service)


@router.get("/{ticker}/upcoming-dividends")
def get_upcoming_dividends(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Get upcoming dividend events for the given stock, preferring Avanza current-year data when available.
    
    Returns:
        A list of upcoming dividend event dictionaries. Each dictionary may contain:
          - `ex_date` (str|None): Ex-dividend date in ISO format, if available.
          - `payment_date` (str|None): Payment date in ISO format, if available.
          - `amount` (number|None): Dividend amount.
          - `currency` (str|None): Currency code of the dividend.
          - `dividend_type` (str|None): Type/category of the dividend.
          - `source` (str|None): Origin of the event (e.g., `"avanza"` when from Avanza); may be absent for other sources.
    
    Raises:
        HTTPException: 404 if the stock for the current user and ticker is not found.
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service
    stock_service = StockService()
    
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    historical_dividends = [
        div for div in (stock_service.get_dividends(ticker, 2) or [])
        if _is_on_or_after_purchase_date(div.get('date'), stock.purchase_date)
    ]
    historical_event_keys = {
        (
            div.get('date') or '',
            div.get('payment_date') or '',
            div.get('amount'),
            div.get('currency') or '',
            div.get('dividend_type') or '',
        )
        for div in historical_dividends
    }

    today = utc_now().date().isoformat()
    current_year = utc_now().year
    avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        year_dividends = avanza_service.get_stock_dividends_for_year(ticker, current_year)
        if year_dividends:
            upcoming_or_remaining = []
            for div in year_dividends:
                event_key = (
                    div.ex_date or '',
                    div.payment_date or '',
                    div.amount,
                    div.currency or '',
                    div.dividend_type or '',
                )
                if event_key in historical_event_keys:
                    continue
                if not _is_on_or_after_purchase_date(div.ex_date, stock.purchase_date):
                    continue
                if div.payment_date and div.payment_date <= today:
                    continue
                if div.ex_date and div.ex_date <= today:
                    continue
                upcoming_or_remaining.append({
                    'ex_date': div.ex_date,
                    'amount': div.amount,
                    'currency': div.currency,
                    'payment_date': div.payment_date,
                    'dividend_type': div.dividend_type,
                    'source': 'avanza',
                })
            if upcoming_or_remaining:
                return upcoming_or_remaining

    upcoming = stock_service.get_upcoming_dividends(ticker) or []
    return [
        div for div in upcoming
        if _is_on_or_after_purchase_date(div.get('ex_date'), stock.purchase_date)
    ]


@router.get("/{ticker}/analyst")
def get_analyst_data(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
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
    
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
def add_manual_dividend(ticker: str, dividend_data: ManualDividendCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Add a manually recorded dividend to the specified stock's manual dividends list.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
        dividend_data (ManualDividendCreate): Dividend fields: `date`, `amount`, optional `currency` (defaults to the stock currency), and optional `note`.
        
    Returns:
        The updated Stock object with the new manual dividend appended.
        
    Raises:
        HTTPException: 404 if the stock with the given ticker is not found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    manual_divs = stock.manual_dividends or []
    new_dividend = {
        "id": str(uuid.uuid4()),
        "date": dividend_data.date,
        "amount": dividend_data.amount,
        "currency": dividend_data.currency or stock.currency,
        "note": dividend_data.note or "",
        "added_at": utc_now().isoformat(),
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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update a manual dividend entry for a stock.
    
    Applies any provided fields from `dividend_data` to the manual dividend identified by `dividend_id` and updates its `updated_at` timestamp to the current UTC time.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
        dividend_id (str): UUID of the manual dividend to update.
        dividend_data (ManualDividendUpdate): Fields to modify on the dividend.
        
    Returns:
        StockResponse: The stock object with the modified `manual_dividends` list.
        
    Raises:
        HTTPException: 404 if the stock or the specified dividend is not found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
            div["updated_at"] = utc_now().isoformat()
            found = True
            break
    
    if not found:
        raise HTTPException(status_code=404, detail="Dividend not found")
    
    stock.manual_dividends = manual_divs
    db.commit()
    db.refresh(stock)
    return stock


@router.delete("/{ticker}/manual-dividends/{dividend_id}")
def delete_manual_dividend(ticker: str, dividend_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
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
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
def suppress_broker_dividend(ticker: str, data: SuppressDividendCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
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
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
        "suppressed_at": utc_now().isoformat(),
    }
    suppressed.append(suppression)
    stock.suppressed_dividends = suppressed
    
    db.commit()
    return {"message": "Dividend suppressed", "suppression": suppression}


@router.delete("/{ticker}/suppress-dividend/{date}")
def restore_broker_dividend(ticker: str, date: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
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
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
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
def get_suppressed_dividends(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Retrieve all suppressed dividends for a stock.
    
    Args:
        ticker: The stock ticker symbol.
        db: Database session dependency.
    
    Returns:
        list: List of suppressed dividend records.
    
    Raises:
        HTTPException: 404 if stock not found.
    """
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    return stock.suppressed_dividends or []


@router.get("/{ticker}/price-history")
def get_stock_price_history(ticker: str, days: int = 30, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Return historical price records for a stock over the requested number of days.
    
    Returns:
        list: Each item is a dict with keys `date` (ISO 8601 string), `price` (numeric), and `currency` (string).
    
    Raises:
        HTTPException: 404 if the stock with the given ticker is not found.
    """
    ticker_upper = ticker.upper()
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker_upper
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    from datetime import timedelta
    start_date = utc_now() - timedelta(days=days)
    
    history = db.query(StockPriceHistory).filter(
        StockPriceHistory.user_id == current_user.id,
        StockPriceHistory.ticker == ticker_upper,
        StockPriceHistory.recorded_at >= start_date
    ).order_by(StockPriceHistory.recorded_at.asc()).all()
    
    return [{
        "date": h.recorded_at.isoformat(),
        "price": h.price,
        "currency": h.currency
    } for h in history]
