"""Stock portfolio API endpoints.

This module provides API endpoints for managing stocks in a portfolio,
including CRUD operations, dividend tracking, and analyst data.
"""

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel, ValidationError
from typing import Optional
import uuid
import logging
import math
import time
import json
import hashlib
import threading
from datetime import date, datetime

from app.main import get_db, get_current_user, User, Stock, StockCreate, StockUpdate, StockResponse, StockPriceHistory
from app.utils.time import utc_now
from app.services.brandfetch_service import brandfetch_service
from app.services.position_service import calculate_position_snapshot, get_quantity_held_on_date, get_remaining_quantity, has_position_history, normalize_position_entries, validate_position_entries

router = APIRouter()
logger = logging.getLogger(__name__)
MAX_BATCH_TICKERS = 25
MAX_YEARS = 10
DIVIDENDS_BATCH_CACHE_TTL_SECONDS = 300
_dividends_batch_cache_lock = threading.Lock()
_dividends_batch_cache: dict[str, tuple[float, dict]] = {}


def _parse_event_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        try:
            return datetime.fromisoformat(value).date()
        except ValueError:
            try:
                return date.fromisoformat(value.split('T', 1)[0])
            except ValueError:
                return None


def _normalize_optional_currency_code(value: Optional[str]) -> Optional[str]:
    if value in (None, ''):
        return None
    normalized = str(value).strip().upper()
    return normalized or None


def _is_after_purchase_date(event_date: Optional[str], purchase_date: Optional[date]) -> bool:
    """
    Determine whether an event date is strictly after the given purchase date; if either date is missing, treat it as valid.
    
    Parameters:
        event_date (Optional[str]): Event date as an ISO-formatted string (YYYY-MM-DD) or None/empty.
        purchase_date (Optional[date]): Purchase date as a date object or None.
    
    Returns:
        bool: `True` if `purchase_date` is None or `event_date` is missing, or if `event_date` is strictly after `purchase_date`; `False` otherwise.
    """
    if purchase_date is None or not event_date:
        return True
    event_date_value = _parse_event_date(event_date)
    if event_date_value is None:
        return True
    return event_date_value > purchase_date


def _get_normalized_stock_position_entries(stock: Stock) -> list[dict]:
    return normalize_position_entries(
        getattr(stock, 'position_entries', None),
        stock.quantity,
        stock.purchase_price,
        stock.purchase_date,
    )


def _resolve_stock_purchase_date(stock: Stock) -> Optional[date]:
    snapshot = calculate_position_snapshot(_get_normalized_stock_position_entries(stock), position_currency=stock.currency)
    purchase_date = snapshot.get('purchase_date')
    return _parse_event_date(purchase_date) if purchase_date else stock.purchase_date


def _apply_stock_position_snapshot(stock: Stock) -> Stock:
    stock.position_entries = normalize_position_entries(
        getattr(stock, 'position_entries', None),
        stock.quantity,
        stock.purchase_price,
        stock.purchase_date,
    )
    snapshot = calculate_position_snapshot(stock.position_entries, position_currency=stock.currency)
    stock.quantity = snapshot['quantity']
    stock.purchase_price = snapshot['purchase_price']
    stock.purchase_date = _parse_event_date(snapshot['purchase_date'])
    stock.position_entries = snapshot['position_entries']
    return stock


def _build_position_snapshot_from_stock_data(stock_data: StockCreate | StockUpdate, payload_fields: set[str]) -> dict:
    if stock_data.position_entries:
        if {"quantity", "purchase_price", "purchase_date", "courtage", "courtage_currency", "exchange_rate", "exchange_rate_currency", "platform"} & payload_fields:
            raise HTTPException(
                status_code=400,
                detail="Provide either position_entries or scalar fields quantity, purchase_price, purchase_date, courtage, exchange_rate, and platform, not both.",
            )
        try:
            position_entries = validate_position_entries(stock_data.position_entries)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return calculate_position_snapshot(position_entries)

    purchase_price = getattr(stock_data, 'purchase_price', None)
    courtage = getattr(stock_data, 'courtage', None)
    if courtage not in (None, 0) and (purchase_price is None or purchase_price <= 0):
        raise HTTPException(status_code=400, detail="courtage requires purchase_price")

    try:
        return calculate_position_snapshot([{
            'quantity': getattr(stock_data, 'quantity', None),
            'purchase_price': purchase_price,
            'courtage': courtage,
            'courtage_currency': getattr(stock_data, 'courtage_currency', None),
            'exchange_rate': getattr(stock_data, 'exchange_rate', None),
            'exchange_rate_currency': getattr(stock_data, 'exchange_rate_currency', None),
            'platform': getattr(stock_data, 'platform', None),
            'purchase_date': getattr(stock_data, 'purchase_date', None),
            'sell_date': None,
        }])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _append_position_entries(stock: Stock, additional_entries: list[dict]) -> Stock:
    existing_entries = _get_normalized_stock_position_entries(stock)
    stock.position_entries = [*existing_entries, *additional_entries]
    return _apply_stock_position_snapshot(stock)


def _build_dividends_batch_cache_key(user_id: int, years: int, normalized_tickers: list[str], stocks_by_ticker: dict[str, Stock]) -> str:
    fingerprint_stocks = []
    for ticker in normalized_tickers:
        stock = stocks_by_ticker[ticker]
        fingerprint_stocks.append({
            "ticker": stock.ticker,
            "currency": stock.currency,
            "quantity": stock.quantity,
            "purchase_price": stock.purchase_price,
            "purchase_date": stock.purchase_date.isoformat() if stock.purchase_date else None,
            "position_entries": normalize_position_entries(
                getattr(stock, "position_entries", None),
                stock.quantity,
                stock.purchase_price,
                stock.purchase_date,
            ),
            "manual_dividends": stock.manual_dividends or [],
            "suppressed_dividends": stock.suppressed_dividends or [],
        })

    payload = json.dumps({
        "user_id": user_id,
        "years": years,
        "current_year": utc_now().year,
        "tickers": normalized_tickers,
        "stocks": fingerprint_stocks,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _get_cached_dividends_batch(cache_key: str) -> Optional[dict]:
    now = time.time()
    with _dividends_batch_cache_lock:
        cached = _dividends_batch_cache.get(cache_key)
        if cached is None:
            return None
        cached_at, value = cached
        if (now - cached_at) >= DIVIDENDS_BATCH_CACHE_TTL_SECONDS:
            _dividends_batch_cache.pop(cache_key, None)
            return None
        return value


def _store_cached_dividends_batch(cache_key: str, value: dict) -> dict:
    with _dividends_batch_cache_lock:
        _dividends_batch_cache[cache_key] = (time.time(), value)
    return value


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
    normalized_ticker = stock.ticker or ticker.upper()
    dividends_raw = stock_service.get_dividends(normalized_ticker, years)
    ownership_entries = _get_normalized_stock_position_entries(stock)
    dividends = [
        div for div in (dividends_raw or [])
        if get_quantity_held_on_date(ownership_entries, div.get('date')) > 0
    ]
    mapped_year_dividends = []
    today = utc_now().date()

    avanza_mapping = avanza_service.get_mapping_by_ticker(normalized_ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        current_year = utc_now().year
        for year in range(current_year - years + 1, current_year + 1):
            year_dividends = avanza_service.get_stock_dividends_for_year(normalized_ticker, year) or []
            for div in year_dividends:
                payout_date = _parse_event_date(div.payment_date or div.ex_date)
                if payout_date and payout_date > today:
                    continue
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
        if get_quantity_held_on_date(ownership_entries, div.get('date')) > 0
    ]

    deduped = {}
    for div in [*dividends, *mapped_year_dividends]:
        normalized_currency = div.get('currency') or stock.currency or ''
        key = (
            div.get('date') or '',
            div.get('amount'),
            normalized_currency,
            div.get('payment_date') or '',
            div.get('dividend_type') or '',
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

    relaxed_groups: dict[tuple[str, object, str], list[tuple[tuple[str, object, str, str, str], dict]]] = {}
    for full_key, div in deduped.items():
        normalized_currency = div.get('currency') or stock.currency or ''
        relaxed_key = (
            div.get('date') or '',
            div.get('amount'),
            normalized_currency,
        )
        relaxed_groups.setdefault(relaxed_key, []).append((full_key, div))

    for entries in relaxed_groups.values():
        if len(entries) <= 1:
            continue

        scored_entries = [
            (
                full_key,
                div,
                int(bool(div.get('payment_date'))) + int(bool(div.get('dividend_type'))) + (2 if div.get('source') == 'avanza' else 0),
            )
            for full_key, div in entries
        ]
        best_score = max(score for _, _, score in scored_entries)
        best_entries = [entry for entry in scored_entries if entry[2] == best_score]
        if len(best_entries) != 1:
            continue

        best_full_key = best_entries[0][0]
        for full_key, _, score in scored_entries:
            if full_key != best_full_key and score < best_score:
                deduped.pop(full_key, None)

    merged_dividends = list(deduped.values())
    merged_dividends.sort(key=lambda item: item.get('date') or '', reverse=True)
    return merged_dividends


def _build_lookup_stock_response(ticker: str, stock_service) -> dict:
    normalized_ticker = ticker.strip().upper()
    info = stock_service.get_stock_info(normalized_ticker)
    if not info or info.get("current_price") is None:
        raise HTTPException(status_code=404, detail="Stock not found")

    logo_url = None
    try:
        logo_url = brandfetch_service.get_logo_url_for_ticker(
            normalized_ticker,
            info.get("name"),
            force_refresh=False,
            existing_logo=None,
        )
    except Exception as exc:
        logger.warning("Failed to resolve lookup logo for %s: %s", normalized_ticker, exc)

    return {
        "id": 0,
        "ticker": normalized_ticker,
        "name": info.get("name"),
        "quantity": 0,
        "currency": info.get("currency") or "USD",
        "sector": info.get("sector"),
        "logo": logo_url,
        "purchase_price": None,
        "purchase_date": None,
        "position_entries": [],
        "current_price": info.get("current_price"),
        "previous_close": info.get("previous_close"),
        "dividend_yield": info.get("dividend_yield"),
        "dividend_per_share": info.get("dividend_per_share"),
        "last_updated": utc_now(),
        "manual_dividends": [],
        "suppressed_dividends": [],
    }


def _get_lookup_upcoming_dividends(ticker: str, stock_service, avanza_service) -> list[dict]:
    normalized_ticker = ticker.strip().upper()
    today = utc_now().date()
    current_year = utc_now().year

    avanza_mapping = avanza_service.get_mapping_by_ticker(normalized_ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        year_dividends = avanza_service.get_stock_dividends_for_year(normalized_ticker, current_year)
        if year_dividends:
            upcoming_or_remaining = []
            for div in year_dividends:
                cutoff_date = _parse_event_date(div.payment_date or div.ex_date)
                if cutoff_date and cutoff_date <= today:
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

    upcoming = stock_service.get_upcoming_dividends(normalized_ticker) or []
    return [
        div for div in upcoming
        if not (
            (cutoff_date := _parse_event_date(div.get('payment_date') or div.get('ex_date')))
            and cutoff_date <= today
        )
    ]

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
    """
    Return all stocks for the current user.

    This route intentionally avoids logo refresh work so read-heavy pages can load
    without waiting on external logo providers.
    
    Returns:
        list[Stock]: Stocks belonging to the current user.
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    stale_logos_cleared = False

    for stock in stocks:
        normalized_logo = brandfetch_service.normalize_stored_logo_url(stock.logo)
        if normalized_logo != stock.logo:
            stock.logo = normalized_logo
            stale_logos_cleared = True

    for stock in stocks:
        _apply_stock_position_snapshot(stock)

    if stale_logos_cleared:
        db.commit()

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


@router.get("/lookup/{ticker}", response_model=StockResponse)
def lookup_stock(ticker: str):
    """
    Return market data for a ticker without requiring it to exist in the user's portfolio.

    The response matches the portfolio stock shape closely so the frontend can reuse the
    detail page for ad-hoc ticker lookups.
    """
    from app.services.stock_service import StockService

    stock_service = StockService()
    return _build_lookup_stock_response(ticker, stock_service)


@router.get("/lookup/{ticker}/dividends")
def lookup_stock_dividends(ticker: str, years: int = 5):
    """
    Return dividend history for a ticker without filtering by portfolio ownership.
    """
    from app.services.stock_service import StockService

    stock_service = StockService()
    normalized_ticker = ticker.strip().upper()

    if years < 1 or years > MAX_YEARS:
        raise HTTPException(
            status_code=400,
            detail=f"years must be between 1 and {MAX_YEARS}",
        )

    dividends = stock_service.get_dividends(normalized_ticker, years)
    return dividends or []


@router.get("/lookup/{ticker}/upcoming-dividends")
def lookup_upcoming_dividends(ticker: str):
    """
    Return upcoming dividend events for a ticker without requiring a portfolio position.
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service

    stock_service = StockService()
    return _get_lookup_upcoming_dividends(ticker, stock_service, avanza_service)


@router.get("/lookup/{ticker}/analyst")
def lookup_analyst_data(ticker: str):
    """
    Return analyst recommendations and price targets for a ticker without requiring a portfolio position.
    """
    from app.services.stock_service import StockService

    stock_service = StockService()
    normalized_ticker = ticker.strip().upper()
    all_recommendations = stock_service.get_all_analyst_recommendations(normalized_ticker)
    price_targets = stock_service.get_price_targets(normalized_ticker)
    latest_rating = stock_service.get_latest_rating(normalized_ticker)

    return {
        "recommendations": all_recommendations.get('yfinance'),
        "finnhub_recommendations": all_recommendations.get('finnhub'),
        "price_targets": price_targets,
        "latest_rating": latest_rating,
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

    started_at = time.perf_counter()
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

    cache_key = _build_dividends_batch_cache_key(current_user.id, years, normalized_tickers, stocks_by_ticker)
    cached_value = _get_cached_dividends_batch(cache_key)
    if cached_value is not None:
        logger.info(
            "Stock dividends batch route user_id=%s tickers=%s years=%s cached=true duration_ms=%.1f",
            current_user.id,
            len(normalized_tickers),
            years,
            (time.perf_counter() - started_at) * 1000,
        )
        return cached_value

    result = {
        ticker: _get_merged_stock_dividends(stocks_by_ticker[ticker], stocks_by_ticker[ticker].ticker or ticker, years, stock_service, avanza_service)
        for ticker in normalized_tickers
    }
    logger.info(
        "Stock dividends batch route user_id=%s tickers=%s years=%s cached=false duration_ms=%.1f",
        current_user.id,
        len(normalized_tickers),
        years,
        (time.perf_counter() - started_at) * 1000,
    )
    return _store_cached_dividends_batch(cache_key, result)


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

    if brandfetch_service.should_refresh_logo(stock.logo):
        original_logo = stock.logo
        try:
            refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
                stock.ticker,
                stock.name,
                force_refresh=False,
                existing_logo=stock.logo,
            )
        except Exception as exc:
            logger.warning("Failed to refresh logo for %s: %s", stock.ticker, exc)
        else:
            if refreshed_logo and refreshed_logo != stock.logo:
                stock.logo = refreshed_logo
                db.commit()
                db.refresh(stock)
            elif original_logo and brandfetch_service.should_refresh_logo(original_logo):
                stock.logo = None
                db.commit()
                db.refresh(stock)
    return _apply_stock_position_snapshot(stock)


@router.post("", response_model=StockResponse)
def create_stock(payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Create and persist a new stock record in the portfolio.
    
    Validates the provided ticker, fetches market metadata and a logo, sets timestamps, and saves the new Stock to the database.
    
    Parameters:
        payload (dict): Raw request body used to construct `StockCreate` inside the handler.
    
    Returns:
        Stock: The newly created stock record.
    
    Raises:
        HTTPException: 400 if the stock already exists, the ticker is invalid, or stock information could not be retrieved.
    """
    from app.services.stock_service import StockService
    from app.services.brandfetch_service import brandfetch_service
    from app.services.avanza_service import avanza_service
    stock_service = StockService()
    
    try:
        stock_data = StockCreate(**payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Invalid stock create payload",
                "errors": exc.errors(),
            },
        ) from exc

    ticker = stock_data.ticker.upper()
    logger.info(f"Attempting to add stock: {ticker}")
    
    payload_fields = set(payload)
    snapshot = _build_position_snapshot_from_stock_data(stock_data, payload_fields)
    quantity = snapshot['quantity']
    purchase_price = snapshot['purchase_price']
    purchase_date = _parse_event_date(snapshot['purchase_date'])

    existing = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker,
    ).first()
    if existing:
        _append_position_entries(existing, snapshot['position_entries'])
        db.commit()
        db.refresh(existing)
        logger.info("Added new lot to existing stock: %s", ticker)
        return existing

    is_valid = stock_service.validate_ticker(ticker)
    logger.info(f"Ticker {ticker} validation result: {is_valid}")

    if not is_valid:
        raise HTTPException(status_code=400, detail=f"Invalid ticker symbol '{ticker}'. Could not find stock data. Try a different symbol or check if the market is open.")

    info = stock_service.get_stock_info(ticker)
    logger.info(f"Stock info for {ticker}: {info}")

    if not info:
        raise HTTPException(status_code=400, detail=f"Could not fetch stock information for '{ticker}'. Please try again.")

    avanza_service.ensure_mapping_for_ticker(ticker)
    logo = brandfetch_service.get_logo_url_for_ticker(ticker, info.get("name"))
    
    stock = Stock(
        user_id=current_user.id,
        ticker=ticker,
        name=info.get("name"),
        quantity=quantity,
        currency=info.get("currency", "USD"),
        sector=info.get("sector"),
        logo=logo,
        purchase_price=purchase_price,
        purchase_date=purchase_date,
        position_entries=snapshot['position_entries'],
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
    from app.services.stock_service import StockService

    stock_service = StockService()
    requested_ticker = ticker.upper()
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == requested_ticker
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    provided_fields = getattr(stock_data, "model_fields_set", getattr(stock_data, "__fields_set__", set()))
    target_ticker = stock.ticker

    if "ticker" in provided_fields:
        normalized_ticker = (stock_data.ticker or "").strip().upper()
        if not normalized_ticker:
            raise HTTPException(status_code=400, detail="ticker cannot be empty")
        if normalized_ticker != stock.ticker:
            existing = db.query(Stock).filter(
                Stock.user_id == current_user.id,
                Stock.ticker == normalized_ticker,
                Stock.id != stock.id,
            ).first()
            if existing:
                raise HTTPException(status_code=400, detail=f"Stock '{normalized_ticker}' already exists in your portfolio")
            if not stock_service.validate_ticker(normalized_ticker):
                raise HTTPException(status_code=400, detail=f"Invalid ticker symbol '{normalized_ticker}'")
            info = stock_service.get_stock_info(normalized_ticker)
            if not info:
                raise HTTPException(status_code=400, detail=f"Could not fetch stock information for '{normalized_ticker}'")

            stock.ticker = normalized_ticker
            stock.name = info.get("name") or stock.name
            stock.currency = info.get("currency") or stock.currency
            stock.sector = info.get("sector") or stock.sector
            stock.current_price = info.get("current_price")
            stock.previous_close = info.get("previous_close")
            stock.dividend_yield = info.get("dividend_yield")
            stock.dividend_per_share = info.get("dividend_per_share")
            stock.last_updated = utc_now()

            try:
                refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
                    normalized_ticker,
                    stock.name or info.get("name"),
                    force_refresh=True,
                    existing_logo=None,
                )
            except Exception as exc:
                logger.warning("Failed to refresh logo for %s during ticker change: %s", normalized_ticker, exc)
                refreshed_logo = None
            stock.logo = refreshed_logo
            target_ticker = normalized_ticker

    if "position_entries" in provided_fields:
        if {"quantity", "purchase_price", "purchase_date", "courtage", "courtage_currency", "exchange_rate", "exchange_rate_currency", "platform"} & set(provided_fields):
            raise HTTPException(
                status_code=400,
                detail="Provide either position_entries or scalar fields quantity, purchase_price, purchase_date, courtage, exchange_rate, and platform, not both.",
            )
        try:
            position_entries = validate_position_entries(stock_data.position_entries or [])
            snapshot = calculate_position_snapshot(position_entries, position_currency=stock.currency)
            stock.position_entries = snapshot['position_entries']
            stock.quantity = snapshot['quantity']
            stock.purchase_price = snapshot['purchase_price']
            stock.purchase_date = _parse_event_date(snapshot['purchase_date'])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        if "quantity" in provided_fields and (stock_data.quantity is None or stock_data.quantity <= 0):
            raise HTTPException(status_code=400, detail="quantity must be greater than zero")
        if "purchase_price" in provided_fields and (stock_data.purchase_price is None or stock_data.purchase_price < 0):
            raise HTTPException(status_code=400, detail="purchase_price must be greater than or equal to zero")
        if "courtage" in provided_fields and stock_data.courtage is not None and stock_data.courtage < 0:
            raise HTTPException(status_code=400, detail="courtage must be greater than or equal to zero")
        if "courtage_currency" in provided_fields and stock_data.courtage_currency not in (None, ''):
            normalized_courtage_currency = _normalize_optional_currency_code(stock_data.courtage_currency)
            if len(normalized_courtage_currency) != 3 or not normalized_courtage_currency.isalpha():
                raise HTTPException(status_code=400, detail="courtage_currency must be a 3-letter currency code")
        if (
            "exchange_rate" in provided_fields
            and stock_data.exchange_rate is not None
            and (not math.isfinite(stock_data.exchange_rate) or stock_data.exchange_rate <= 0)
        ):
            raise HTTPException(status_code=400, detail="exchange_rate must be greater than zero")
        effective_purchase_price = (
            stock_data.purchase_price
            if "purchase_price" in provided_fields
            else stock.purchase_price
        )
        if "courtage" in provided_fields and stock_data.courtage not in (None, 0) and (effective_purchase_price is None or effective_purchase_price <= 0):
            raise HTTPException(status_code=400, detail="courtage requires purchase_price")
        if (
            "purchase_date" in provided_fields
            and stock_data.purchase_date is not None
            and _parse_event_date(stock_data.purchase_date.isoformat()) is None
        ):
            raise HTTPException(status_code=400, detail="purchase_date must be a valid date")

        existing_entries = _get_normalized_stock_position_entries(stock)
        open_entries = [entry for entry in existing_entries if get_remaining_quantity(entry) > 0]
        existing_open_entry = open_entries[0] if len(open_entries) == 1 else None
        effective_exchange_rate = (
            stock_data.exchange_rate
            if "exchange_rate" in provided_fields
            else (existing_open_entry.get('exchange_rate') if existing_open_entry else None)
        )
        effective_exchange_rate_currency = (
            _normalize_optional_currency_code(stock_data.exchange_rate_currency)
            if "exchange_rate_currency" in provided_fields
            else (
                None
                if "exchange_rate_currency" in provided_fields
                else _normalize_optional_currency_code(existing_open_entry.get('exchange_rate_currency') if existing_open_entry else None)
            )
        )
        effective_courtage_currency = (
            _normalize_optional_currency_code(stock_data.courtage_currency)
            if "courtage_currency" in provided_fields
            else (
                None
                if "courtage_currency" in provided_fields
                else _normalize_optional_currency_code(existing_open_entry.get('courtage_currency') if existing_open_entry else None)
            )
        )
        if effective_exchange_rate is not None and (not math.isfinite(effective_exchange_rate) or effective_exchange_rate <= 0):
            raise HTTPException(status_code=400, detail="exchange_rate must be greater than zero")
        if (
            ("exchange_rate" in provided_fields or "exchange_rate_currency" in provided_fields)
            and (effective_exchange_rate is not None or effective_exchange_rate_currency is not None)
        ):
            if effective_exchange_rate is None:
                raise HTTPException(status_code=400, detail="exchange_rate_currency requires exchange_rate")
            if effective_exchange_rate_currency is None:
                raise HTTPException(status_code=400, detail="exchange_rate requires exchange_rate_currency")
            if len(effective_exchange_rate_currency) != 3 or not effective_exchange_rate_currency.isalpha():
                raise HTTPException(status_code=400, detail="exchange_rate_currency must be a 3-letter currency code")

        if stock_data.quantity is not None:
            stock.quantity = stock_data.quantity
        if stock_data.purchase_price is not None:
            stock.purchase_price = stock_data.purchase_price
        if "purchase_date" in provided_fields:
            stock.purchase_date = stock_data.purchase_date
        scalar_patch_fields = {"quantity", "purchase_price", "purchase_date", "courtage", "courtage_currency", "exchange_rate", "exchange_rate_currency", "platform"} & set(provided_fields)
        if scalar_patch_fields and isinstance(getattr(stock, 'position_entries', None), list):
            updated_entries = []
            open_entry_indexes = []
            for entry in stock.position_entries:
                if not isinstance(entry, dict):
                    continue
                updated_entry = dict(entry)
                updated_entries.append(updated_entry)
                if get_remaining_quantity(updated_entry) > 0:
                    open_entry_indexes.append(len(updated_entries) - 1)

            if len(open_entry_indexes) > 1:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Scalar stock updates are ambiguous when multiple open lots exist; "
                        "provide full position_entries instead."
                    ),
                )

            if not open_entry_indexes:
                updated_entries.append({
                    'quantity': stock.quantity,
                    'purchase_price': stock.purchase_price,
                    'courtage': stock_data.courtage if "courtage" in scalar_patch_fields else 0,
                    'courtage_currency': effective_courtage_currency,
                    'exchange_rate': stock_data.exchange_rate if "exchange_rate" in scalar_patch_fields else None,
                    'exchange_rate_currency': effective_exchange_rate_currency if "exchange_rate_currency" in scalar_patch_fields or "exchange_rate" in scalar_patch_fields else None,
                    'platform': stock_data.platform if "platform" in scalar_patch_fields else None,
                    'purchase_date': stock.purchase_date,
                    'sell_date': None,
                    'sold_quantity': None,
                })
                open_entry_indexes = [len(updated_entries) - 1]

            first_open_entry = updated_entries[open_entry_indexes[0]]
            if "quantity" in scalar_patch_fields:
                existing_sold_quantity = first_open_entry.get('sold_quantity')
                if existing_sold_quantity not in (None, ''):
                    try:
                        sold_quantity = float(existing_sold_quantity)
                    except (TypeError, ValueError):
                        sold_quantity = 0.0
                    first_open_entry['quantity'] = stock.quantity + max(sold_quantity, 0.0)
                else:
                    first_open_entry['quantity'] = stock.quantity
            if len(open_entry_indexes) == 1:
                if "purchase_price" in scalar_patch_fields:
                    first_open_entry['purchase_price'] = stock.purchase_price
                if "courtage" in scalar_patch_fields:
                    first_open_entry['courtage'] = stock_data.courtage
                if "courtage_currency" in scalar_patch_fields:
                    first_open_entry['courtage_currency'] = effective_courtage_currency
                if "purchase_date" in scalar_patch_fields:
                    first_open_entry['purchase_date'] = stock.purchase_date
                if "exchange_rate" in scalar_patch_fields:
                    first_open_entry['exchange_rate'] = stock_data.exchange_rate
                if "exchange_rate_currency" in scalar_patch_fields:
                    first_open_entry['exchange_rate_currency'] = effective_exchange_rate_currency
                elif "exchange_rate" in scalar_patch_fields:
                    first_open_entry['exchange_rate_currency'] = effective_exchange_rate_currency
                if "platform" in scalar_patch_fields:
                    first_open_entry['platform'] = stock_data.platform
            stock.position_entries = updated_entries
        stock.position_entries = normalize_position_entries(
            getattr(stock, 'position_entries', None),
            stock.quantity,
            stock.purchase_price,
            stock.purchase_date,
            stock_data.courtage if "courtage" in scalar_patch_fields else None,
        )
        snapshot = calculate_position_snapshot(stock.position_entries, position_currency=stock.currency)
        stock.quantity = snapshot['quantity']
        stock.purchase_price = snapshot['purchase_price']
        stock.purchase_date = _parse_event_date(snapshot['purchase_date'])
        stock.position_entries = snapshot['position_entries']

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
    
    normalized_ticker = stock.ticker or ticker.upper()
    info = stock_service.get_stock_info(normalized_ticker)
    if info:
        stock.name = info.get("name") or stock.name
        stock.current_price = info.get("current_price")
        stock.previous_close = info.get("previous_close")
        stock.dividend_yield = info.get("dividend_yield")
        stock.dividend_per_share = info.get("dividend_per_share")
        stock.sector = info.get("sector") or stock.sector
        stock.last_updated = utc_now()
        
        original_logo = stock.logo
        try:
            refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
                stock.ticker,
                stock.name or info.get("name"),
                force_refresh=True,
                existing_logo=stock.logo,
            )
        except Exception as exc:
            logger.warning("Failed to refresh logo for %s: %s", stock.ticker, exc)
            refreshed_logo = None
        if refreshed_logo:
            stock.logo = refreshed_logo
        elif original_logo and brandfetch_service.should_refresh_logo(original_logo):
            stock.logo = None
        
        db.commit()
        db.refresh(stock)
    
    return stock


@router.get("/{ticker}/dividends")
def get_stock_dividends(ticker: str, years: int = 5, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Return the merged, deduplicated dividend history for a stock over a given number of years.
    
    Retrieves combined dividend records from local storage and Avanza for the specified ticker, filters out dividends before the stock's purchase date, deduplicates and scores overlapping records, and sorts the result by date descending.
    
    Parameters:
        ticker (str): Stock ticker symbol (case-insensitive).
        years (int): Number of years of history to include; must be between 1 and MAX_YEARS (default 5).
    
    Returns:
        list: A list of dividend records (dicts) containing fields such as `date`, `amount`, `currency`, `payment_date`, `dividend_type`, and source metadata.
    
    Raises:
        HTTPException: 404 if the stock is not found for the current user.
        HTTPException: 400 if `years` is outside the allowed range.
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

    started_at = time.perf_counter()
    dividends = _get_merged_stock_dividends(stock, stock.ticker or ticker.upper(), years, stock_service, avanza_service)
    logger.info(
        "Stock dividends route ticker=%s years=%s count=%s duration_ms=%.1f",
        stock.ticker or ticker.upper(),
        years,
        len(dividends),
        (time.perf_counter() - started_at) * 1000,
    )
    return dividends


@router.get("/{ticker}/upcoming-dividends")
def get_upcoming_dividends(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Retrieve upcoming dividend events for the given stock, preferring Avanza current-year data when available.
    
    Returns:
        A list of upcoming dividend event dictionaries. Each dictionary contains any of the following keys:
          - `ex_date` (str|None): Ex-dividend date in ISO format, if available.
          - `payment_date` (str|None): Payment date in ISO format, if available.
          - `amount` (number|None): Dividend amount.
          - `currency` (str|None): Currency code of the dividend.
          - `dividend_type` (str|None): Type or category of the dividend.
          - `source` (str|None): Origin of the event (for example, `"avanza"` when sourced from Avanza).
    
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
    
    started_at = time.perf_counter()
    normalized_ticker = stock.ticker or ticker.upper()
    ownership_entries = _get_normalized_stock_position_entries(stock)
    historical_dividends = [
        div for div in (stock_service.get_dividends(normalized_ticker, 2) or [])
        if get_quantity_held_on_date(ownership_entries, div.get('date')) > 0
    ]
    historical_event_keys = {
        (
            div.get('date') or '',
            div.get('payment_date') or '',
            div.get('amount'),
            div.get('currency') or stock.currency or '',
            div.get('dividend_type') or '',
        )
        for div in historical_dividends
    }

    today = utc_now().date()
    current_year = utc_now().year
    avanza_mapping = avanza_service.get_mapping_by_ticker(normalized_ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        year_dividends = avanza_service.get_stock_dividends_for_year(normalized_ticker, current_year)
        if year_dividends:
            upcoming_or_remaining = []
            seen_event_keys = set(historical_event_keys)
            for div in year_dividends:
                event_key = (
                    div.ex_date or '',
                    div.payment_date or '',
                    div.amount,
                    div.currency or stock.currency or '',
                    div.dividend_type or '',
                )
                if event_key in seen_event_keys:
                    continue
                if get_quantity_held_on_date(ownership_entries, div.ex_date) <= 0:
                    continue
                cutoff_date = _parse_event_date(div.payment_date or div.ex_date)
                if cutoff_date and cutoff_date <= today:
                    continue
                upcoming_or_remaining.append({
                    'ex_date': div.ex_date,
                    'amount': div.amount,
                    'currency': div.currency,
                    'payment_date': div.payment_date,
                    'dividend_type': div.dividend_type,
                    'source': 'avanza',
                })
                seen_event_keys.add(event_key)

            upcoming = stock_service.get_upcoming_dividends(normalized_ticker) or []
            for div in upcoming:
                event_key = (
                    div.get('ex_date') or '',
                    div.get('payment_date') or '',
                    div.get('amount'),
                    div.get('currency') or stock.currency or '',
                    div.get('dividend_type') or '',
                )
                if event_key in seen_event_keys:
                    continue
                if get_quantity_held_on_date(ownership_entries, div.get('ex_date')) <= 0:
                    continue
                cutoff_date = _parse_event_date(div.get('payment_date') or div.get('ex_date'))
                if cutoff_date and cutoff_date <= today:
                    continue
                upcoming_or_remaining.append(div)
                seen_event_keys.add(event_key)

            logger.info(
                "Upcoming dividends route ticker=%s source=avanza count=%s duration_ms=%.1f",
                normalized_ticker,
                len(upcoming_or_remaining),
                (time.perf_counter() - started_at) * 1000,
            )
            return upcoming_or_remaining

    upcoming = stock_service.get_upcoming_dividends(normalized_ticker) or []
    filtered_upcoming = [
        div for div in upcoming
        if get_quantity_held_on_date(ownership_entries, div.get('ex_date')) > 0
        and not (
            (cutoff_date := _parse_event_date(div.get('payment_date') or div.get('ex_date')))
            and cutoff_date <= today
        )
    ]
    logger.info(
        "Upcoming dividends route ticker=%s source=stock_service count=%s duration_ms=%.1f",
        normalized_ticker,
        len(filtered_upcoming),
        (time.perf_counter() - started_at) * 1000,
    )
    return filtered_upcoming


@router.get("/{ticker}/analyst")
def get_analyst_data(ticker: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Fetch analyst recommendations and price targets for the given stock ticker.
    
    Returns:
        dict: Mapping with keys:
            - `recommendations`: list of yfinance recommendation entries or `None`.
            - `finnhub_recommendations`: list of finnhub recommendation entries or `None`.
            - `price_targets`: price target data or `None`.
            - `latest_rating`: latest consolidated analyst rating or `None`.
    
    Raises:
        HTTPException: 404 if the stock does not exist for the current user.
    """
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    stock = db.query(Stock).filter(
        Stock.user_id == current_user.id,
        Stock.ticker == ticker.upper()
    ).first()
    if not stock:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    started_at = time.perf_counter()
    normalized_ticker = stock.ticker or ticker.upper()
    all_recommendations = stock_service.get_all_analyst_recommendations(normalized_ticker)
    price_targets = stock_service.get_price_targets(normalized_ticker)
    latest_rating = stock_service.get_latest_rating(normalized_ticker)

    duration_ms = (time.perf_counter() - started_at) * 1000
    logger.info(
        "Analyst route ticker=%s yfinance_count=%s finnhub_count=%s has_price_targets=%s duration_ms=%.1f",
        normalized_ticker,
        len(all_recommendations.get('yfinance') or []),
        len(all_recommendations.get('finnhub') or []),
        price_targets is not None,
        duration_ms,
    )
    
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
