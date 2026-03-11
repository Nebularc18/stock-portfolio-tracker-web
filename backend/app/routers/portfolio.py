"""Portfolio summary and analytics API endpoints.

This module provides API endpoints for portfolio summaries, historical
performance, distribution analysis, and bulk refresh operations.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
from datetime import date, datetime, timezone
from typing import List, Optional
import logging

from app.main import get_db, get_current_user, User, Stock, PortfolioHistory, UserSettings, StockPriceHistory
from app.services.exchange_rate_service import ExchangeRateService
from app.services.brandfetch_service import brandfetch_service
from app.utils.time import utc_now

router = APIRouter()
logger = logging.getLogger(__name__)


def parse_event_date(value) -> Optional[date]:
    """
    Parse a date-like value and return a date object.

    Accepts a datetime.date, datetime.datetime, or string representation (ISO date or ISO datetime; accepts a trailing 'Z' UTC designator). Leading/trailing whitespace is ignored. If the input is None, empty, not a supported type, or cannot be parsed, returns None.

    Parameters:
        value: A date/datetime object or a string to parse.

    Returns:
        A datetime.date parsed from the input, or `None` if parsing fails or the input is invalid.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None

    normalized = value.strip()
    if not normalized:
        return None

    normalized = normalized.replace('Z', '+00:00')

    try:
        return datetime.fromisoformat(normalized).date()
    except ValueError:
        if 'T' in normalized:
            normalized = normalized.split('T', 1)[0]
        elif ' ' in normalized:
            normalized = normalized.split(' ', 1)[0]

        try:
            return datetime.fromisoformat(normalized).date()
        except ValueError:
            return None


def sort_event_date(value) -> date:
    parsed = parse_event_date(value)
    return parsed if parsed is not None else date.max


def normalize_dividend_event(raw_div: dict, event_type: str) -> dict:
    """
    Normalize a raw dividend event into a standardized dictionary with consistent keys.

    Parameters:
        raw_div (dict): Raw dividend data containing any of 'date' (historical), 'ex_date' (upcoming), 'payment_date', 'amount', 'currency', 'source', and 'dividend_type'.
        event_type (str): Indicates the input shape; use 'historical' when the ex-date is provided under the 'date' key, otherwise the function will read 'ex_date'.

    Returns:
        dict: Normalized dividend event with keys:
            - 'ex_date': ex-dividend date string (from 'date' for historical events or 'ex_date' otherwise).
            - 'payment_date': payment date value from the input or None.
            - 'amount': dividend amount per share from the input or None.
            - 'currency': currency code from the input or None.
            - 'source': data source (defaults to 'yahoo' if not provided).
            - 'dividend_type': dividend classification from the input or None.
    """
    if event_type == 'historical':
        ex_date = raw_div.get('date', '')
    else:
        ex_date = raw_div.get('ex_date', '')

    return {
        'ex_date': ex_date,
        'payment_date': raw_div.get('payment_date'),
        'amount': raw_div.get('amount'),
        'currency': raw_div.get('currency'),
        'source': raw_div.get('source', 'yahoo'),
        'dividend_type': raw_div.get('dividend_type')
    }


def dividend_event_merge_key(event: dict) -> Optional[tuple[str, ...]]:
    """
    Compute a merge key for a dividend event to support deduplication.
    
    Parameters:
        event (dict): Dividend event containing at least an 'ex_date' and optionally a 'dividend_type'.
    
    Returns:
        tuple[str, ...] | None: A key tuple for merging:
          - (ex_date,) if 'dividend_type' is missing,
          - (ex_date, dividend_type) if present,
          - `None` if 'ex_date' is missing.
    """
    ex_date = event.get('ex_date')
    if not ex_date:
        return None

    dividend_type = event.get('dividend_type')
    if not dividend_type:
        return (ex_date,)

    return ex_date, dividend_type


def get_yahoo_normalized_events(stock_service, ticker: str) -> list:
    """
    Create a merged list of normalized dividend events for the given ticker by combining Yahoo historical (last 2 years) and upcoming data.
    
    Historical events are normalized and indexed by their merge key (ex_date and dividend_type); upcoming events are normalized and either used to enrich matching historical entries (filling missing payment_date, currency, or dividend_type) or appended when no match exists.
    
    Returns:
        list: A list of normalized dividend event dictionaries, with historical events enriched by matching upcoming events when available.
    """
    historical = stock_service.get_dividends(ticker, years=2) or []
    upcoming = stock_service.get_upcoming_dividends(ticker) or []

    normalized = [normalize_dividend_event(div, 'historical') for div in historical]

    historical_by_ex_date = {
        merge_key: event
        for event in normalized
        if (merge_key := dividend_event_merge_key(event)) is not None
    }

    for div in upcoming:
        normalized_upcoming = normalize_dividend_event(div, 'upcoming')
        upcoming_key = dividend_event_merge_key(normalized_upcoming)
        historical_event = historical_by_ex_date.get(upcoming_key) if upcoming_key else None
        got_from_wildcard = False
        if historical_event is None and upcoming_key and len(upcoming_key) > 1:
            historical_event = historical_by_ex_date.get((upcoming_key[0],))
            got_from_wildcard = historical_event is not None
        if historical_event is not None:
            if not historical_event.get('payment_date') and normalized_upcoming.get('payment_date'):
                historical_event['payment_date'] = normalized_upcoming.get('payment_date')
            if not historical_event.get('currency') and normalized_upcoming.get('currency'):
                historical_event['currency'] = normalized_upcoming.get('currency')
            if not historical_event.get('dividend_type') and normalized_upcoming.get('dividend_type'):
                historical_event['dividend_type'] = normalized_upcoming.get('dividend_type')
            if upcoming_key:
                historical_by_ex_date[upcoming_key] = historical_event
            fallback_key = dividend_event_merge_key(historical_event)
            if fallback_key:
                historical_by_ex_date[fallback_key] = historical_event
            if got_from_wildcard and upcoming_key:
                historical_by_ex_date.pop((upcoming_key[0],), None)
            continue
        normalized.append(normalized_upcoming)
        if upcoming_key:
            historical_by_ex_date[upcoming_key] = normalized_upcoming

    return normalized

def get_display_currency(db: Session, user_id: int) -> str:
    """
    Return the user's preferred display currency.
    
    Returns:
        display_currency (str): The user's currency code (e.g., "USD", "SEK"). Defaults to "SEK" if the user has no settings.
    """
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if settings:
        return settings.display_currency
    return "SEK"


def convert_value(value: float, from_currency: str, to_currency: str, rates: dict) -> Optional[float]:
    """
    Convert a monetary value from one currency to another using the provided exchange rates.
    
    The `rates` mapping should use keys of the form "SRC_TGT" (e.g., "USD_SEK") with numeric rates. If a direct or inverse rate for the source/target pair exists the function applies it; if not, it may attempt conversion via SEK as an intermediary. If no viable conversion path is available, the function returns None.
    
    Parameters:
        value (float): Amount in the source currency.
        from_currency (str): Source currency ISO code.
        to_currency (str): Target currency ISO code.
        rates (dict): Mapping of exchange rate keys (e.g., {"USD_SEK": 10.5, "SEK_EUR": 0.09}) to numeric rates.
    
    Returns:
        float: Converted amount in the target currency, or `None` if no applicable rate is found.
    """
    if from_currency == to_currency:
        return value
    
    key = f"{from_currency}_{to_currency}"
    if key in rates and rates[key]:
        return value * rates[key]
    
    inverse_key = f"{to_currency}_{from_currency}"
    if inverse_key in rates and rates[inverse_key]:
        return value / rates[inverse_key]

    if from_currency != 'SEK' and to_currency != 'SEK':
        sek_key = f"{from_currency}_SEK"
        target_key = f"SEK_{to_currency}"
        inverse_sek_key = f"SEK_{from_currency}"
        inverse_target_key = f"{to_currency}_SEK"

        if rates.get(sek_key) and rates.get(target_key):
            return value * rates[sek_key] * rates[target_key]
        if rates.get(sek_key) and rates.get(inverse_target_key):
            return value * rates[sek_key] / rates[inverse_target_key]
        if rates.get(inverse_sek_key) and rates.get(target_key):
            return (value / rates[inverse_sek_key]) * rates[target_key]
        if rates.get(inverse_sek_key) and rates.get(inverse_target_key):
            return (value / rates[inverse_sek_key]) / rates[inverse_target_key]

    return None


COUNTRY_BY_TICKER_SUFFIX = {
    '.ST': 'Sweden',
    '.DE': 'Germany',
    '.PA': 'France',
    '.MI': 'Italy',
    '.AS': 'Netherlands',
    '.BR': 'Belgium',
    '.TO': 'Canada',
    '.HK': 'Hong Kong',
    '.AX': 'Australia',
    '.T': 'Japan',
    '.SI': 'Singapore',
    '.L': 'United Kingdom',
    '.SW': 'Switzerland',
    '.HE': 'Finland',
    '.CO': 'Denmark',
    '.OL': 'Norway',
}


def infer_country_from_ticker(ticker: str) -> Optional[str]:
    """
    Infer the country associated with a stock ticker using known suffix mappings and simple heuristics.
    
    Parameters:
        ticker (str): Stock ticker or symbol; may include an exchange suffix (e.g., ".ST", ".DE").
    
    Returns:
        country (Optional[str]): Country name matched from suffix mappings, "United States" when the ticker has no suffix and is non-empty, or `None` if no inference can be made.
    """
    ticker_upper = (ticker or '').upper()
    for suffix, country in COUNTRY_BY_TICKER_SUFFIX.items():
        if ticker_upper.endswith(suffix):
            return country
    if '.' not in ticker_upper and ticker_upper:
        return 'United States'
    return None


@router.get("/summary")
def get_portfolio_summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Calculate portfolio summary including totals and per-stock metrics in the user's display currency.
    
    Returns:
        dict: A summary object with keys:
            total_value (float): Total portfolio value in display currency.
            total_cost (float): Total cost basis in display currency.
            total_gain_loss (float): Aggregate gain or loss in display currency.
            total_gain_loss_percent (float): Gain or loss as a percentage (0 if total_cost <= 0).
            display_currency (str): Currency code used for display values.
            stocks (list): Per-stock dictionaries containing:
                - ticker, name, quantity, current_price, current_value, currency, sector, logo
                - gain_loss (float or None), gain_loss_percent (float or None)
                - current_value_converted (bool), cost_converted (bool)
            stock_count (int): Number of stocks processed.
            unconverted_stocks (list): Entries for stocks omitted from totals due to missing exchange rates.
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    display_currency = get_display_currency(db, current_user.id)

    logos_updated = False
    for stock in stocks:
        refreshed_logo = brandfetch_service.get_logo_url_for_ticker(
            stock.ticker,
            stock.name,
            force_refresh=False,
            existing_logo=stock.logo,
        )
        if refreshed_logo and refreshed_logo != stock.logo:
            stock.logo = refreshed_logo
            logos_updated = True

    if logos_updated:
        db.commit()
        for stock in stocks:
            db.refresh(stock)
    
    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    total_value = 0
    total_cost = 0
    total_gain_loss = 0
    
    stock_data = []
    unconverted_stocks = []
    
    for stock in stocks:
        if stock.current_price is not None and stock.quantity is not None:
            current_value_native = stock.current_price * stock.quantity
            current_value = convert_value(current_value_native, stock.currency, display_currency, rates)
            
            if current_value is None:
                logger.warning(
                    f"Skipping {stock.ticker} in totals: no conversion rate for "
                    f"{stock.currency} to {display_currency}"
                )
                unconverted_stocks.append({
                    "ticker": stock.ticker,
                    "currency": stock.currency,
                    "reason": "missing_exchange_rate"
                })
                stock_data.append({
                    "ticker": stock.ticker,
                    "name": stock.name,
                    "quantity": stock.quantity,
                    "current_price": stock.current_price,
                    "current_value": current_value_native,
                    "currency": stock.currency,
                    "sector": stock.sector,
                    "logo": stock.logo,
                    "gain_loss": None,
                    "gain_loss_percent": None,
                    "current_value_converted": False,
                    "cost_converted": False,
                })
                continue
            
            total_value += current_value
            
            cost_native = 0
            cost = 0
            cost_converted = False
            if stock.purchase_price is not None:
                cost_native = stock.purchase_price * stock.quantity
                cost = convert_value(cost_native, stock.currency, display_currency, rates)
                if cost is None:
                    logger.warning(
                        f"Skipping {stock.ticker} cost in totals: no conversion rate for "
                        f"{stock.currency} to {display_currency}"
                    )
                    unconverted_stocks.append({
                        "ticker": stock.ticker,
                        "currency": stock.currency,
                        "reason": "missing_exchange_rate_for_cost"
                    })
                    gain_loss = None
                else:
                    total_cost += cost
                    gain_loss = current_value - cost
                    total_gain_loss += gain_loss
                    cost_converted = True
            else:
                gain_loss = None

            gain_loss_percent = None
            if gain_loss is not None and cost_converted and isinstance(cost, (int, float)) and cost > 0:
                gain_loss_percent = gain_loss / cost * 100
            
            stock_data.append({
                "ticker": stock.ticker,
                "name": stock.name,
                "quantity": stock.quantity,
                "current_price": stock.current_price,
                "current_value": current_value,
                "currency": stock.currency,
                "sector": stock.sector,
                "logo": stock.logo,
                "gain_loss": gain_loss,
                "gain_loss_percent": gain_loss_percent,
                "current_value_converted": True,
                "cost_converted": cost_converted if stock.purchase_price is not None else True,
            })
    
    total_gain_loss_percent = (total_gain_loss / total_cost * 100) if total_cost > 0 else 0
    
    return {
        "total_value": total_value,
        "total_cost": total_cost,
        "total_gain_loss": total_gain_loss,
        "total_gain_loss_percent": total_gain_loss_percent,
        "display_currency": display_currency,
        "stocks": stock_data,
        "stock_count": len(stocks),
        "unconverted_stocks": unconverted_stocks,
    }


@router.post("/refresh-all")
def refresh_all_prices(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Refresh current prices and logos for all portfolio stocks, record daily price history, and update the portfolio's total value.
    
    Fetches price and metadata from external services, upserts per-stock today's price history, converts per-stock values to SEK to compute the portfolio total for the current 15-minute interval, and upserts that total into PortfolioHistory.
    
    Returns:
        dict: Response containing:
            - message (str): Summary, e.g. "Refreshed 5 stocks".
            - skipped (int): Number of stocks skipped due to missing exchange rates.
            - logos_backfilled (int): Number of stocks that received a logo where none existed.
            - logos_refreshed (int): Number of stocks whose logo URL was updated.
    """
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    stock_service = StockService()
    
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    updated = 0
    total_value_sek = 0
    logos_backfilled = 0
    logos_refreshed = 0
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
    
    skipped = 0
    request_ts = utc_now()
    today = request_ts.replace(hour=0, minute=0, second=0, microsecond=0)
    for stock in stocks:
        info = stock_service.get_stock_info(stock.ticker)
        if info:
            stock.current_price = info.get('current_price')
            stock.previous_close = info.get('previous_close')
            stock.sector = info.get('sector') or stock.sector
            stock.dividend_yield = info.get('dividend_yield')
            stock.dividend_per_share = info.get('dividend_per_share')
            stock.last_updated = request_ts
            updated += 1

        logo_url = brandfetch_service.get_logo_url_for_ticker(
            stock.ticker,
            stock.name,
            force_refresh=False,
            existing_logo=stock.logo,
        )
        if logo_url and logo_url != stock.logo:
            if not stock.logo:
                logos_backfilled += 1
            else:
                logos_refreshed += 1
            stock.logo = logo_url
        
        if stock.current_price is not None:
            price_stmt = insert(StockPriceHistory).values(
                user_id=current_user.id,
                ticker=stock.ticker,
                price=stock.current_price,
                currency=stock.currency,
                recorded_at=today,
            )
            price_stmt = price_stmt.on_conflict_do_update(
                index_elements=[
                    StockPriceHistory.user_id,
                    StockPriceHistory.ticker,
                    StockPriceHistory.recorded_at,
                ],
                set_={
                    "price": price_stmt.excluded.price,
                    "currency": price_stmt.excluded.currency,
                },
            )
            db.execute(price_stmt)
        
        if stock.current_price is not None and stock.quantity is not None:
            value = stock.current_price * stock.quantity
            converted_value = convert_value(value, stock.currency, 'SEK', rates)
            if converted_value is not None:
                total_value_sek += converted_value
            else:
                logger.warning(
                    f"Skipping {stock.ticker}: no conversion rate for "
                    f"{stock.currency} to SEK"
                )
                skipped += 1
    
    if skipped > 0:
        logger.warning(
            f"Portfolio history includes partial FX data: skipped {skipped} stock(s) due to missing conversion rates"
        )

    if updated > 0 and total_value_sek > 0:
        interval = request_ts.replace(minute=(request_ts.minute // 15) * 15, second=0, microsecond=0)
        stmt = insert(PortfolioHistory).values(
            user_id=current_user.id,
            date=interval,
            total_value=total_value_sek,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[PortfolioHistory.user_id, PortfolioHistory.date],
            set_={"total_value": stmt.excluded.total_value},
        )
        db.execute(stmt)
    
    db.commit()
    
    return {
        "message": f"Refreshed {updated} stocks",
        "skipped": skipped,
        "logos_backfilled": logos_backfilled,
        "logos_refreshed": logos_refreshed,
    }


@router.get("/history", response_model=List[dict])
def get_portfolio_history(
    days: int = Query(30, ge=1),
    range_key: Optional[str] = Query(None, alias="range"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return portfolio total-value snapshots for a requested historical range.
    
    Parameters:
        days (int): Fallback number of days to include when `range_key` is not provided; will be coerced to an integer between 1 and 3650.
        range_key (Optional[str]): Optional predefined range; supported values: "1d", "1w", "1m", "ytd", "1y", "since_start", "all". If provided, it takes precedence over `days`.
        
    Returns:
        List[dict]: Ordered list of records with keys `date` (timestamp) and `value` (total portfolio value) sorted ascending by date.
    """
    from datetime import timedelta
    
    now = utc_now()
    since = None
    normalized_range = (range_key or "").strip().lower()

    if normalized_range == "1d":
        since = now - timedelta(days=1)
    elif normalized_range == "1w":
        since = now - timedelta(days=7)
    elif normalized_range == "1m":
        since = now - timedelta(days=30)
    elif normalized_range == "ytd":
        since = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    elif normalized_range == "1y":
        since = now - timedelta(days=365)
    elif normalized_range in {"since_start", "all"}:
        since = None
    else:
        days = max(1, min(days, 3650))
        since = now - timedelta(days=days)

    query = db.query(PortfolioHistory).filter(PortfolioHistory.user_id == current_user.id)
    if since is not None:
        query = query.filter(PortfolioHistory.date >= since)

    history = query.order_by(PortfolioHistory.date.asc()).all()
    return [{"date": h.date, "value": h.total_value} for h in history]


@router.get("/distribution")
def get_portfolio_distribution(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Compute the portfolio's value distribution aggregated by sector, country, currency, and ticker, expressed using the user's display currency.
    
    Returns:
        dict: A mapping with keys:
            - display_currency (str): The user's display currency code.
            - by_sector (dict): sector name -> total market value for that sector (converted to display currency).
            - by_country (dict): country name -> total market value for that country (converted to display currency).
            - by_currency (dict): currency code -> total market value in that native currency (not converted).
            - by_stock (dict): ticker -> total market value for that stock (converted to display currency).
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    display_currency = get_display_currency(db, current_user.id)
    currencies = {stock.currency for stock in stocks if stock.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    by_sector = {}
    by_country = {}
    by_currency = {}
    by_stock = {}
    
    for stock in stocks:
        if stock.current_price is not None and stock.quantity is not None:
            value_native = stock.current_price * stock.quantity
            by_currency[stock.currency] = by_currency.get(stock.currency, 0) + value_native
            value = convert_value(value_native, stock.currency, display_currency, rates)
            if value is None:
                continue
            
            sector = stock.sector or "Unknown"
            by_sector[sector] = by_sector.get(sector, 0) + value

            country = infer_country_from_ticker(stock.ticker) or "Unknown"
            by_country[country] = by_country.get(country, 0) + value

            by_stock[stock.ticker] = by_stock.get(stock.ticker, 0) + value
    
    return {
        "display_currency": display_currency,
        "by_sector": by_sector,
        "by_country": by_country,
        "by_currency": by_currency,
        "by_stock": by_stock,
    }


@router.get("/upcoming-dividends")
def get_upcoming_portfolio_dividends(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Collect current-year dividend events for all portfolio stocks and convert per-stock totals into the user's display currency.
    
    Normalizes dividend sources (Avanza or Yahoo), skips events the user is not entitled to (entitlement before purchase_date), deduplicates identical events, and marks each event as 'paid' or 'upcoming' based on payout date.
    
    Returns:
        dict: {
            'dividends': list of dict — Each item contains:
                - 'ticker' (str)
                - 'name' (str)
                - 'quantity' (number)
                - 'ex_date' (str or None)
                - 'payment_date' (str or None)
                - 'payout_date' (str) — chosen payment_date or ex_date
                - 'status' (str) — 'paid' or 'upcoming'
                - 'dividend_type' (str or None)
                - 'amount_per_share' (number)
                - 'total_amount' (number) — amount_per_share * quantity
                - 'currency' (str) — original dividend currency
                - 'total_converted' (float or None) — total_amount converted to display currency, or None if conversion unavailable
                - 'display_currency' (str)
                - 'source' (str) — data source, e.g. 'avanza' or 'yahoo'
            'total_expected' (float): Sum of `total_converted` for dividends with conversion available.
            'total_received' (float): Sum of `total_converted` for dividends with status == 'paid'.
            'total_remaining' (float): Sum of `total_converted` for dividends with status == 'upcoming'.
            'display_currency' (str): The user's display currency used for conversions.
            'unmapped_stocks' (list): List of dicts { 'ticker': str, 'name': str, 'reason': str } for securities lacking Avanza mapping.
        }
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service
    
    stock_service = StockService()
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    display_currency = get_display_currency(db, current_user.id)
    
    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    dividends = []
    unmapped_stocks = []
    seen_unmapped = set()
    now = utc_now()
    today = now.date()
    current_year = now.year

    for stock in stocks:
        purchase_date = stock.purchase_date
        avanza_mapping = avanza_service.get_mapping_by_ticker(stock.ticker)
        no_avanza_mapping = avanza_mapping is None or not avanza_mapping.instrument_id

        if avanza_mapping and avanza_mapping.instrument_id:
            avanza_events = avanza_service.get_stock_dividends_for_year(stock.ticker, current_year)
            if avanza_events:
                normalized_events = [{
                    'ex_date': div.ex_date,
                    'payment_date': div.payment_date,
                    'amount': div.amount,
                    'currency': div.currency,
                    'source': 'avanza',
                    'dividend_type': div.dividend_type
                } for div in avanza_events]
            else:
                normalized_events = get_yahoo_normalized_events(stock_service, stock.ticker)
        else:
            normalized_events = get_yahoo_normalized_events(stock_service, stock.ticker)

        if not normalized_events:
            continue

        seen_event_keys = set()

        for div in normalized_events:
            ex_date = div.get('ex_date', '')
            payment_date = div.get('payment_date')
            payout_date = payment_date or ex_date
            ex_date_parsed = parse_event_date(ex_date)

            payout_date_parsed = parse_event_date(payout_date)
            if not payout_date_parsed:
                continue

            if purchase_date is not None:
                entitlement_date = ex_date_parsed or payout_date_parsed
                if entitlement_date and entitlement_date <= purchase_date:
                    continue

            if payout_date_parsed.year != current_year:
                continue

            event_key = (
                ex_date,
                payment_date,
                div.get('amount'),
                div.get('currency') or stock.currency,
                div.get('dividend_type')
            )
            if event_key in seen_event_keys:
                continue
            seen_event_keys.add(event_key)
            
            amount = div.get('amount')
            if not amount or amount < 0:
                continue
            
            if stock.quantity is None or stock.quantity <= 0:
                continue
            
            total_amount = amount * stock.quantity
            
            div_currency = div.get('currency') or stock.currency
            
            converted_total = convert_value(
                total_amount,
                div_currency,
                display_currency,
                rates
            )
            
            source = div.get('source', 'yahoo')
            status = 'paid' if payout_date_parsed <= today else 'upcoming'
            
            if stock.ticker.endswith('.ST') and source == 'yahoo' and no_avanza_mapping:
                if stock.ticker not in seen_unmapped:
                    seen_unmapped.add(stock.ticker)
                    unmapped_stocks.append({
                        'ticker': stock.ticker,
                        'name': stock.name,
                        'reason': 'no_avanza_mapping'
                    })
            
            dividends.append({
                'ticker': stock.ticker,
                'name': stock.name,
                'quantity': stock.quantity,
                'ex_date': ex_date,
                'payment_date': payment_date,
                'payout_date': payout_date,
                'status': status,
                'dividend_type': div.get('dividend_type'),
                'amount_per_share': amount,
                'total_amount': total_amount,
                'currency': div_currency,
                'total_converted': converted_total,
                'display_currency': display_currency,
                'source': source
            })

    dividends.sort(key=lambda item: (sort_event_date(item.get('payout_date')), sort_event_date(item.get('ex_date'))))
    
    total_expected = sum(
        d['total_converted'] for d in dividends if d['total_converted'] is not None
    )

    total_received = sum(
        d['total_converted']
        for d in dividends
        if d['total_converted'] is not None and d.get('status') == 'paid'
    )

    total_remaining = sum(
        d['total_converted']
        for d in dividends
        if d['total_converted'] is not None and d.get('status') == 'upcoming'
    )
    
    return {
        'dividends': dividends,
        'total_expected': total_expected,
        'total_received': total_received,
        'total_remaining': total_remaining,
        'display_currency': display_currency,
        'unmapped_stocks': unmapped_stocks
    }
