"""Background scheduler for periodic stock data refresh.

This module provides a background scheduler that periodically refreshes
stock prices for all stocks in the portfolio when markets are open.
"""

import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.dialects.postgresql import insert
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

scheduler = BackgroundScheduler()

def refresh_all_stocks():
    """
    Refresh portfolio stock data and record price and portfolio value history.
    
    Checks market hours and, if refresh is allowed for each stock's market, updates each stock's current_price,
    previous_close, sector (preserving existing when unavailable), dividend_yield,
    dividend_per_share, and last_updated in the database. For stocks with a current
    price, records or updates today's StockPriceHistory. Computes the portfolio's
    total value converted to SEK using available exchange rates and, when all
    positions could be converted, upserts the total into PortfolioHistory using a
    15-minute rounded interval. Commits changes and closes the database session.
    
    Notes:
    - If no stock's market is within its refresh window, no work is performed.
    - Individual stocks lacking a conversion rate to SEK are skipped and logged; in that case portfolio history is not recorded.
    """
    from app.main import get_db, Stock, StockPriceHistory, PortfolioHistory
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    from app.services.market_hours_service import MarketHoursService
    
    db = next(get_db())
    try:
        stocks = db.query(Stock).all()
        if not stocks:
            logger.info("No stocks to refresh")
            return

        eligible_stocks = []
        market_closed_count = 0
        for stock in stocks:
            inferred_market = MarketHoursService.infer_market_for_ticker(stock.ticker)
            if inferred_market is None:
                if not MarketHoursService.should_refresh():
                    market_closed_count += 1
                    continue
            elif not MarketHoursService.should_refresh([inferred_market]):
                market_closed_count += 1
                continue
            eligible_stocks.append(stock)

        if not eligible_stocks:
            logger.info("Skipping refresh - no tracked stock markets are within their refresh window")
            return
        
        stock_service = StockService()
        
        currencies = {s.currency for s in eligible_stocks if s.currency}
        rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
        
        updated = 0
        skipped = 0
        request_ts = utc_now()
        today = request_ts.replace(hour=0, minute=0, second=0, microsecond=0)
        user_totals: dict[int, float] = {}
        user_skipped: dict[int, int] = {}
        user_updated: dict[int, int] = {}
        user_ids = {s.user_id for s in eligible_stocks if s.user_id is not None}
        
        for stock in eligible_stocks:
            try:
                info = stock_service.get_stock_info(stock.ticker)
                if not info:
                    logger.warning(f"Skipping {stock.ticker}: no quote info returned")
                    skipped += 1
                    continue

                current_price = info.get('current_price')
                if current_price is None:
                    logger.warning(f"Skipping {stock.ticker}: missing current_price in quote info")
                    skipped += 1
                    continue

                stock.current_price = current_price
                stock.previous_close = info.get('previous_close')
                stock.sector = info.get('sector') or stock.sector
                stock.dividend_yield = info.get('dividend_yield')
                stock.dividend_per_share = info.get('dividend_per_share')
                stock.last_updated = request_ts
                updated += 1

                if stock.user_id is not None:
                    user_updated[stock.user_id] = user_updated.get(stock.user_id, 0) + 1

                price_stmt = insert(StockPriceHistory).values(
                    user_id=stock.user_id,
                    ticker=stock.ticker,
                    price=stock.current_price,
                    currency=stock.currency,
                    recorded_at=today,
                )
                price_stmt = price_stmt.on_conflict_do_update(
                    index_elements=['user_id', 'ticker', 'recorded_at'],
                    set_={
                        'price': stock.current_price,
                        'currency': stock.currency,
                    },
                )
                db.execute(price_stmt)

                # Calculate total portfolio value in SEK for history tracking
                if stock.quantity is not None:
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
                        if stock.user_id is not None:
                            user_totals[stock.user_id] = user_totals.get(stock.user_id, 0) + converted_value
                    else:
                        logger.warning(
                            f"Skipping {stock.ticker}: no conversion rate for "
                            f"{stock.currency} to SEK"
                        )
                        if stock.user_id is not None:
                            user_skipped[stock.user_id] = user_skipped.get(stock.user_id, 0) + 1
                        skipped += 1
            except Exception:
                logger.exception(f"Error refreshing {stock.ticker}")
                if stock.user_id is not None:
                    user_skipped[stock.user_id] = user_skipped.get(stock.user_id, 0) + 1
                skipped += 1
        
        # Record per-user portfolio history for the dashboard chart.
        interval = request_ts.replace(minute=(request_ts.minute // 15) * 15, second=0, microsecond=0)
        for user_id in user_ids:
            total_value_sek = user_totals.get(user_id, 0)
            skipped_for_user = user_skipped.get(user_id, 0)
            updated_for_user = user_updated.get(user_id, 0)
            if updated_for_user <= 0 or total_value_sek <= 0 or skipped_for_user > 0:
                continue

            stmt = insert(PortfolioHistory).values(
                user_id=user_id,
                total_value=total_value_sek,
                date=interval
            ).on_conflict_do_update(
                index_elements=['user_id', 'date'],
                set_={'total_value': total_value_sek}
            )
            db.execute(stmt)
        
        db.commit()
        logger.info(
            "Scheduled refresh: updated %s stocks, skipped %s outside market window",
            updated,
            market_closed_count,
        )
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
