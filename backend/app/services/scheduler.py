import logging
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

scheduler = BackgroundScheduler()


def refresh_all_stocks():
    from app.main import get_db, Stock, StockPriceHistory
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    
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
        for stock in stocks:
            try:
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
            except Exception as e:
                logger.error(f"Error refreshing {stock.ticker}: {e}")
        
        db.commit()
        logger.info(f"Scheduled refresh: updated {updated} stocks")
    except Exception as e:
        logger.error(f"Error in scheduled refresh: {e}")
    finally:
        db.close()


def start_scheduler():
    scheduler.add_job(
        refresh_all_stocks,
        CronTrigger(minute='0,10,20,30,40,50'),
        id='refresh_stocks',
        replace_existing=True
    )
    scheduler.start()
    logger.info("Stock refresh scheduler started (every 10 min at :00, :10, :20, :30, :40, :50)")


def stop_scheduler():
    scheduler.shutdown()
    logger.info("Stock refresh scheduler stopped")
