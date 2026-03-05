"""Portfolio summary and analytics API endpoints.

This module provides API endpoints for portfolio summaries, historical
performance, distribution analysis, and bulk refresh operations.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert
from datetime import datetime, timezone
from typing import List, Optional
import logging

from app.main import get_db, Stock, PortfolioHistory, UserSettings, StockPriceHistory
from app.services.exchange_rate_service import ExchangeRateService
from app.utils.time import utc_now

router = APIRouter()
logger = logging.getLogger(__name__)

def get_display_currency(db: Session) -> str:
    """Retrieve the user's preferred display currency.
    
    Args:
        db: Database session.
    
    Returns:
        str: Display currency code (defaults to 'SEK').
    """
    settings = db.query(UserSettings).first()
    if settings:
        return settings.display_currency
    return "SEK"


def convert_value(value: float, from_currency: str, to_currency: str, rates: dict) -> Optional[float]:
    """Convert a monetary value between currencies using exchange rates.
    
    Args:
        value: The monetary value to convert.
        from_currency: Source currency code.
        to_currency: Target currency code.
        rates: Dictionary of exchange rates (e.g., {'USD_SEK': 10.5}).
    
    Returns:
        float: Converted value, or None if conversion rate not available.
    """
    if from_currency == to_currency:
        return value
    
    key = f"{from_currency}_{to_currency}"
    if key in rates and rates[key]:
        return value * rates[key]
    
    inverse_key = f"{to_currency}_{from_currency}"
    if inverse_key in rates and rates[inverse_key]:
        return value / rates[inverse_key]
    
    return None


@router.get("/summary")
def get_portfolio_summary(db: Session = Depends(get_db)):
    """Calculate portfolio summary with totals and per-stock data.
    
    Args:
        db: Database session dependency.
    
    Returns:
        dict: Portfolio summary containing:
            - total_value (float): Total portfolio value in display currency.
            - total_cost (float): Total cost basis in display currency.
            - total_gain_loss (float): Total gain/loss in display currency.
            - total_gain_loss_percent (float): Gain/loss as percentage.
            - display_currency (str): Currency used for display values.
            - stocks (list): List of stock data dictionaries.
            - stock_count (int): Number of stocks in portfolio.
            - unconverted_stocks (list): Stocks that could not be converted
              to display_currency due to missing exchange rates.
    """
    stocks = db.query(Stock).all()
    display_currency = get_display_currency(db)
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    total_value = 0
    total_cost = 0
    total_gain_loss = 0
    
    stock_data = []
    unconverted_stocks = []
    
    for stock in stocks:
        if stock.current_price and stock.quantity:
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
            if stock.purchase_price:
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
                "gain_loss_percent": ((current_value - cost) / cost * 100) if cost_converted and cost > 0 else None,
                "current_value_converted": True,
                "cost_converted": cost_converted if stock.purchase_price else True,
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
def refresh_all_prices(db: Session = Depends(get_db)):
    """Refresh price data for all stocks in the portfolio.
    
    Fetches current prices from external sources, updates stock records,
    and records daily portfolio value for history tracking.
    
    Args:
        db: Database session dependency.
    
    Returns:
        dict: Response containing:
            - message (str): Summary message, e.g. "Refreshed 5 stocks".
            - skipped (int): Count of stocks skipped due to missing exchange rates.
    """
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    from app.services.brandfetch_service import brandfetch_service
    stock_service = StockService()
    
    stocks = db.query(Stock).all()
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

        should_refresh_logo = True
        if should_refresh_logo:
            logo_url = brandfetch_service.get_logo_url_for_ticker(
                stock.ticker,
                stock.name,
                force_refresh=False,
            )
            if logo_url and logo_url != stock.logo:
                if not stock.logo:
                    logos_backfilled += 1
                else:
                    logos_refreshed += 1
                stock.logo = logo_url
        
        if stock.current_price is not None:
            existing_price = db.query(StockPriceHistory).filter(
                StockPriceHistory.ticker == stock.ticker,
                StockPriceHistory.recorded_at >= today
            ).first()
            
            if existing_price:
                existing_price.price = stock.current_price
            else:
                price_history = StockPriceHistory(
                    ticker=stock.ticker,
                    price=stock.current_price,
                    currency=stock.currency,
                    recorded_at=request_ts
                )
                db.add(price_history)
        
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
        now = utc_now()
        interval = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
        stmt = insert(PortfolioHistory).values(
            total_value=total_value_sek,
            date=interval
        ).on_conflict_do_update(
            index_elements=['date'],
            set_={'total_value': total_value_sek}
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
    db: Session = Depends(get_db)
):
    """Retrieve historical portfolio value snapshots.
    
    Args:
        days: Number of days of history to retrieve.
        range_key: Optional predefined range (1d, 1w, 1m, ytd, 1y, since_start).
        db: Database session dependency.
    
    Returns:
        List[dict]: List of {date, value} records ordered by date ascending.
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
        try:
            days = max(1, min(int(days), 3650))
        except (ValueError, TypeError):
            days = 30
        since = now - timedelta(days=days)

    query = db.query(PortfolioHistory)
    if since is not None:
        query = query.filter(PortfolioHistory.date >= since)

    history = query.order_by(PortfolioHistory.date.asc()).all()
    return [{"date": h.date, "value": h.total_value} for h in history]


@router.get("/distribution")
def get_portfolio_distribution(db: Session = Depends(get_db)):
    """
    Compute portfolio value breakdowns aggregated by sector, currency, and ticker.
    
    Returns:
        dict: Mapping with keys:
            - by_sector (dict): sector name -> total market value for that sector.
            - by_currency (dict): currency code -> total market value in that currency.
            - by_stock (dict): ticker -> total market value for that stock.
    """
    stocks = db.query(Stock).all()
    
    by_sector = {}
    by_currency = {}
    by_stock = {}
    
    for stock in stocks:
        if stock.current_price and stock.quantity:
            value = stock.current_price * stock.quantity
            
            sector = stock.sector or "Unknown"
            by_sector[sector] = by_sector.get(sector, 0) + value
            
            by_currency[stock.currency] = by_currency.get(stock.currency, 0) + value
            
            by_stock[stock.ticker] = by_stock.get(stock.ticker, 0) + value
    
    return {
        "by_sector": by_sector,
        "by_currency": by_currency,
        "by_stock": by_stock,
    }


@router.get("/upcoming-dividends")
def get_upcoming_portfolio_dividends(db: Session = Depends(get_db)):
    """
    Collect current-year dividend events for all portfolio stocks and convert per-stock totals into the user's display currency.
    
    Returns:
        dict: A mapping with keys:
                        - dividends (list): Each item is a dict with keys `ticker`, `name`, `quantity`, `ex_date`, `payment_date`,
              `amount_per_share`, `total_amount` (amount_per_share * quantity), `currency`, `total_converted` (converted to
                            display currency or `None` if conversion not available), `display_currency`, `source`, `payout_date`, and `status`.
                        - total_expected (float): Sum of `total_converted` for current-year dividends where conversion succeeded.
                        - total_received (float): Sum of paid current-year dividends (`status == 'paid'`) where conversion succeeded.
                        - total_remaining (float): Sum of remaining current-year dividends (`status == 'upcoming'`) where conversion succeeded.
            - display_currency (str): The user's display currency used for conversions.
            - unmapped_stocks (list): List of dicts for Swedish tickers without Avanza mapping; each dict has `ticker`,
              `name`, and `reason`.
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service
    
    stock_service = StockService()
    stocks = db.query(Stock).all()
    display_currency = get_display_currency(db)
    
    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    dividends = []
    unmapped_stocks = []
    seen_unmapped = set()
    now = utc_now()
    today = now.strftime('%Y-%m-%d')
    current_year = now.year

    def normalize_dividend_event(raw_div: dict, event_type: str) -> dict:
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
    
    for stock in stocks:
        avanza_mapping = avanza_service.get_mapping_by_ticker(stock.ticker)

        if avanza_mapping and avanza_mapping.instrument_id:
            avanza_events = avanza_service.get_stock_dividends_for_year(stock.ticker, current_year)
            normalized_events = [{
                'ex_date': div.ex_date,
                'payment_date': div.payment_date,
                'amount': div.amount,
                'currency': div.currency,
                'source': 'avanza',
                'dividend_type': div.dividend_type
            } for div in avanza_events]
        else:
            historical = stock_service.get_dividends(stock.ticker, years=2) or []
            upcoming = stock_service.get_upcoming_dividends(stock.ticker) or []

            normalized_events = [normalize_dividend_event(div, 'historical') for div in historical]
            normalized_events.extend(normalize_dividend_event(div, 'upcoming') for div in upcoming)

        if not normalized_events:
            continue

        seen_event_keys = set()

        for div in normalized_events:
            ex_date = div.get('ex_date', '')
            payment_date = div.get('payment_date')
            payout_date = payment_date or ex_date

            if not payout_date or len(payout_date) < 10:
                continue

            try:
                payout_year = int(payout_date[:4])
            except ValueError:
                continue

            if payout_year != current_year:
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
            status = 'paid' if payout_date < today else 'upcoming'
            
            if stock.ticker.endswith('.ST') and source == 'yahoo':
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

    dividends.sort(key=lambda x: (x['payout_date'], x['ex_date']))
    
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
