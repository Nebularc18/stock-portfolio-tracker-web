from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List

from app.main import get_db, Stock, PortfolioHistory

router = APIRouter()


@router.get("/summary")
def get_portfolio_summary(db: Session = Depends(get_db)):
    stocks = db.query(Stock).all()
    
    total_value = 0
    total_cost = 0
    total_gain_loss = 0
    total_gain_loss_percent = 0
    
    stock_data = []
    
    for stock in stocks:
        if stock.current_price and stock.quantity:
            current_value = stock.current_price * stock.quantity
            total_value += current_value
            
            if stock.purchase_price:
                cost = stock.purchase_price * stock.quantity
                total_cost += cost
                gain_loss = current_value - cost
                total_gain_loss += gain_loss
            
            stock_data.append({
                "ticker": stock.ticker,
                "name": stock.name,
                "quantity": stock.quantity,
                "current_price": stock.current_price,
                "current_value": current_value,
                "currency": stock.currency,
                "sector": stock.sector,
                "gain_loss": current_value - (stock.purchase_price * stock.quantity) if stock.purchase_price else None,
                "gain_loss_percent": ((current_value - (stock.purchase_price * stock.quantity)) / (stock.purchase_price * stock.quantity) * 100) if stock.purchase_price else None,
            })
    
    if total_cost > 0:
        total_gain_loss_percent = (total_gain_loss / total_cost) * 100
    
    return {
        "total_value": total_value,
        "total_cost": total_cost,
        "total_gain_loss": total_gain_loss,
        "total_gain_loss_percent": total_gain_loss_percent,
        "stocks": stock_data,
        "stock_count": len(stocks),
    }


@router.post("/refresh-all")
def refresh_all_prices(db: Session = Depends(get_db)):
    from app.services.stock_service import StockService
    stock_service = StockService()
    
    stocks = db.query(Stock).all()
    updated = 0
    
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
