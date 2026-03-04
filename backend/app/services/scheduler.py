"""Background scheduler for periodic stock data refresh.

This module provides a background scheduler that periodically refreshes
stock prices for all stocks in the portfolio when markets are open.
"""

import logging
from datetime import datetime, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.dialects.postgresql import insert

logger = logging.getLogger(__name__)

scheduler = BackgroundScheduler()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def refresh_all_stocks():
    """Refresh all stock prices in the portfolio.
    
    Only refreshes if markets are open or within post-close window.
    Updates current prices and records daily price history.
    Also records portfolio value history for the dashboard chart.
    """
    from app.main import get_db, Stock, StockPriceHistory, PortfolioHistory
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    from app.services.market_hours_service import MarketHoursService
    
    if not MarketHoursService.should_refresh():
        logger.info("Skipping refresh - no markets are open")
        return
    
    db = next(get_db())
    try:
        stocks = db.query(Stock).all()
        if not stocks:
            logger.info("No stocks to refresh")
            return
        
        stock_service = StockService()
        
        currencies = {s.currency for s in stocks if s.currency}
        rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
        
        updated = 0
        total_value_sek = 0
        skipped = 0
        
        for stock in stocks:
            try:
                info = stock_service.get_stock_info(stock.ticker)
                if info:
                    stock.current_price = info.get('current_price')
                    stock.previous_close = info.get('previous_close')
                    stock.sector = info.get('sector') or stock.sector
                    stock.dividend_yield = info.get('dividend_yield')
                    stock.dividend_per_share = info.get('dividend_per_share')
                    stock.last_updated = utc_now()
                    updated += 1
                    
                    if stock.current_price is not None:
                        today = utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
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
                                recorded_at=utc_now()
                            )
                            db.add(price_history)
                    
                    # Calculate total portfolio value in SEK for history tracking
                    if stock.current_price is not None and stock.quantity is not None:
                        value = stock.current_price * stock.quantity
                        converted_value = None
                        if stock.currency == 'SEK':
                            converted_value = value
                        elif rates:
                            key = f"{stock.currency}_SEK"
                            if key in rates and rates[key] is not None:
                                converted_value = value * rates[key]
                            else:
                                inverse_key = f"SEK_{stock.currency}"
                                if inverse_key in rates and rates[inverse_key] is not None and rates[inverse_key] != 0:
                                    converted_value = value / rates[inverse_key]
                        
                        if converted_value is not None:
                            total_value_sek += converted_value
                        else:
                            logger.warning(
                                f"Skipping {stock.ticker}: no conversion rate for "
                                f"{stock.currency} to SEK"
                            )
                            skipped += 1
            except Exception as e:
                logger.error(f"Error refreshing {stock.ticker}: {e}")
        
        # Record portfolio history for the dashboard chart
        if updated > 0 and total_value_sek > 0 and skipped == 0:
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
        logger.info(f"Scheduled refresh: updated {updated} stocks")
    except Exception as e:
        logger.error(f"Error in scheduled refresh: {e}")
    finally:
        db.close()


def start_scheduler():
    """Start the background scheduler for stock refresh.
    
    Schedules stock refresh every 10 minutes at :00, :10, :20, :30, :40, :50.
    """
    scheduler.add_job(
        refresh_all_stocks,
        CronTrigger(minute='0,10,20,30,40,50'),
        id='refresh_stocks',
        replace_existing=True
    )
    scheduler.start()
    logger.info("Stock refresh scheduler started (every 10 min at :00, :10, :20, :30, :40, :50)")


def stop_scheduler():
    """Stop the background scheduler."""
    scheduler.shutdown()
    logger.info("Stock refresh scheduler stopped")
