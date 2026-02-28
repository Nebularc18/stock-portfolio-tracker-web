"""Portfolio summary and analytics API endpoints.

This module provides API endpoints for portfolio summaries, historical
performance, distribution analysis, and bulk refresh operations.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List, Optional
import logging

from app.main import get_db, Stock, PortfolioHistory, UserSettings, StockPriceHistory
from app.services.exchange_rate_service import ExchangeRateService

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
    """
    Refresh current prices for all portfolio stocks, update their records and price history, and upsert the portfolio total value into history using a 15-minute interval.
    
    Updates each Stock with the latest fetched fields, creates or updates a StockPriceHistory entry for today's price when available, and records a PortfolioHistory entry for the current 15-minute interval when any stocks were updated and a total SEK value could be computed.
    
    Returns:
        dict: A response with:
            - message (str): Summary text, e.g. "Refreshed 5 stocks".
            - skipped (int): Number of stocks skipped when a SEK conversion rate was unavailable.
    """
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    stock_service = StockService()
    
    stocks = db.query(Stock).all()
    updated = 0
    total_value_sek = 0
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
    
    skipped = 0
    for stock in stocks:
        info = stock_service.get_stock_info(stock.ticker)
        if info:
            stock.current_price = info.get('current_price')
            stock.previous_close = info.get('previous_close')
            stock.sector = info.get('sector') or stock.sector
            stock.dividend_yield = info.get('dividend_yield')
            stock.dividend_per_share = info.get('dividend_per_share')
            stock.last_updated = datetime.utcnow()
            updated += 1
            
            if stock.current_price:
                today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
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
                        recorded_at=datetime.utcnow()
                    )
                    db.add(price_history)
            
            if stock.current_price and stock.quantity:
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
    
    if updated > 0 and total_value_sek > 0:
        now = datetime.utcnow()
        interval = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
        existing = db.query(PortfolioHistory).filter(PortfolioHistory.date == interval).first()
        if existing:
            existing.total_value = total_value_sek
        else:
            history_entry = PortfolioHistory(total_value=total_value_sek, date=interval)
            db.add(history_entry)
    
    db.commit()
    
    return {"message": f"Refreshed {updated} stocks", "skipped": skipped}


@router.get("/history", response_model=List[dict])
def get_portfolio_history(days: int = 30, db: Session = Depends(get_db)):
    """
    Retrieve portfolio value snapshots for a recent period.
    
    Parameters:
        days (int): Number of days of history to retrieve; values are constrained to the range 1 through 90. Invalid inputs default to 30.
    
    Returns:
        List[dict]: Records ordered by date ascending, each with keys `date` (timestamp) and `value` (total portfolio value).
    """
    from datetime import timedelta
    
    MAX_DAYS = 90
    try:
        days = max(1, min(int(days), MAX_DAYS))
    except (ValueError, TypeError):
        days = 30
    
    since = datetime.utcnow() - timedelta(days=days)
    history = db.query(PortfolioHistory).filter(PortfolioHistory.date >= since).order_by(PortfolioHistory.date.asc()).all()
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
    Collect upcoming dividend events for all portfolio stocks and convert per-stock totals into the user's display currency.
    
    Returns:
        dict: A mapping with keys:
            - dividends (list): Each item is a dict with keys `ticker`, `name`, `quantity`, `ex_date`, `payment_date`,
              `amount_per_share`, `total_amount` (amount_per_share * quantity), `currency`, `total_converted` (converted to
              display currency or `None` if conversion not available), `display_currency`, and `source`.
            - total_expected (float): Sum of `total_converted` for dividends where conversion succeeded.
            - display_currency (str): The user's display currency used for conversions.
            - unmapped_stocks (list): List of dicts for Swedish tickers without Avanza mapping; each dict has `ticker`,
              `name`, and `reason`.
    """
    from app.services.stock_service import StockService
    
    stock_service = StockService()
    stocks = db.query(Stock).all()
    display_currency = get_display_currency(db)
    
    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    dividends = []
    unmapped_stocks = []
    seen_unmapped = set()
    today = datetime.utcnow().strftime('%Y-%m-%d')
    
    for stock in stocks:
        upcoming = stock_service.get_upcoming_dividends(stock.ticker)
        
        if not upcoming:
            continue
        
        for div in upcoming:
            ex_date = div.get('ex_date', '')
            if ex_date < today:
                continue
            
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
                'payment_date': div.get('payment_date'),
                'amount_per_share': amount,
                'total_amount': total_amount,
                'currency': div_currency,
                'total_converted': converted_total,
                'display_currency': display_currency,
                'source': source
            })
    
    dividends.sort(key=lambda x: x['ex_date'])
    
    total_expected = sum(
        d['total_converted'] for d in dividends if d['total_converted'] is not None
    )
    
    return {
        'dividends': dividends,
        'total_expected': total_expected,
        'display_currency': display_currency,
        'unmapped_stocks': unmapped_stocks
    }
