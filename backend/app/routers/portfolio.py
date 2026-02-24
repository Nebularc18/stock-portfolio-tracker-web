from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List, Optional

from app.main import get_db, Stock, PortfolioHistory, UserSettings
from app.services.exchange_rate_service import ExchangeRateService

router = APIRouter()


def get_display_currency(db: Session) -> str:
    settings = db.query(UserSettings).first()
    if settings:
        return settings.display_currency
    return "SEK"


def convert_value(value: float, from_currency: str, to_currency: str, rates: dict) -> Optional[float]:
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
    stocks = db.query(Stock).all()
    display_currency = get_display_currency(db)
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    total_value = 0
    total_cost = 0
    total_gain_loss = 0
    
    stock_data = []
    
    for stock in stocks:
        if stock.current_price and stock.quantity:
            current_value_native = stock.current_price * stock.quantity
            current_value = convert_value(current_value_native, stock.currency, display_currency, rates)
            
            if current_value is None:
                current_value = current_value_native
            
            total_value += current_value
            
            cost_native = 0
            cost = 0
            if stock.purchase_price:
                cost_native = stock.purchase_price * stock.quantity
                cost = convert_value(cost_native, stock.currency, display_currency, rates)
                if cost is None:
                    cost = cost_native
                total_cost += cost
                gain_loss = current_value - cost
                total_gain_loss += gain_loss
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
                "gain_loss_percent": ((current_value - cost) / cost * 100) if cost and cost > 0 else None,
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
    }


@router.post("/refresh-all")
def refresh_all_prices(db: Session = Depends(get_db)):
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    stock_service = StockService()
    
    stocks = db.query(Stock).all()
    updated = 0
    total_value_sek = 0
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
    
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
            
            if stock.current_price and stock.quantity:
                value = stock.current_price * stock.quantity
                if stock.currency == 'SEK':
                    total_value_sek += value
                elif stock.currency == 'USD' and rates.get('USD_SEK'):
                    total_value_sek += value * rates['USD_SEK']
                elif stock.currency == 'EUR' and rates.get('EUR_SEK'):
                    total_value_sek += value * rates['EUR_SEK']
                else:
                    total_value_sek += value
    
    if updated > 0 and total_value_sek > 0:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        existing = db.query(PortfolioHistory).filter(PortfolioHistory.date >= today).first()
        if existing:
            existing.total_value = total_value_sek
        else:
            history_entry = PortfolioHistory(total_value=total_value_sek, date=datetime.utcnow())
            db.add(history_entry)
    
    db.commit()
    
    return {"message": f"Refreshed {updated} stocks"}


@router.get("/history", response_model=List[dict])
def get_portfolio_history(days: int = 30, db: Session = Depends(get_db)):
    history = db.query(PortfolioHistory).order_by(PortfolioHistory.date.desc()).limit(days).all()
    return [{"date": h.date, "value": h.total_value} for h in history]


@router.get("/distribution")
def get_portfolio_distribution(db: Session = Depends(get_db)):
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
