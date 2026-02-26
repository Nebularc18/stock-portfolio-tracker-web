from fastapi import APIRouter, HTTPException
from typing import Optional, Dict, Any, List

from app.services.marketstack_service import marketstack_service, FetchError
from app.services.stock_service import StockService

router = APIRouter()
stock_service = StockService()


@router.get("/status")
def get_status() -> Dict[str, Any]:
    return marketstack_service.get_usage_status()


@router.get("/dividends/{ticker}")
def get_dividends(
    ticker: str,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    use_cache: bool = True
) -> Dict[str, Any]:
    if not marketstack_service.is_configured():
        raise HTTPException(
            status_code=503, 
            detail="Marketstack API key not configured. Set MARKETSTACK_API_KEY environment variable."
        )
    
    try:
        dividends = marketstack_service.fetch_dividends(
            ticker, 
            date_from=date_from, 
            date_to=date_to,
            use_cache=use_cache
        )
    except FetchError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e
    
    if dividends is None:
        raise HTTPException(
            status_code=404, 
            detail=f"No dividend data found for {ticker}"
        )
    
    return {
        'ticker': ticker.upper(),
        'dividends': [{'date': d.date, 'amount': d.amount} for d in dividends],
        'count': len(dividends),
        'usage': marketstack_service.get_usage_status()
    }


@router.post("/verify/{ticker}")
def verify_dividends(ticker: str, use_cache: bool = True) -> Dict[str, Any]:
    if not marketstack_service.is_configured():
        raise HTTPException(
            status_code=503, 
            detail="Marketstack API key not configured. Set MARKETSTACK_API_KEY environment variable."
        )
    
    yahoo_dividends = stock_service.get_dividends(ticker, years=1)
    
    try:
        result = marketstack_service.verify_dividends(
            ticker, 
            yahoo_dividends,
            use_cache=use_cache
        )
    except FetchError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e
    
    return {
        'ticker': result.ticker,
        'verified_at': result.verified_at,
        'cached': result.cached,
        'summary': {
            'yahoo_count': result.yahoo_count,
            'marketstack_count': result.marketstack_count,
            'match_count': result.match_count,
            'discrepancy_count': result.discrepancy_count
        },
        'yahoo_dividends': result.yahoo_dividends,
        'marketstack_dividends': result.marketstack_dividends,
        'discrepancies': result.discrepancies,
        'usage': marketstack_service.get_usage_status()
    }


@router.delete("/cache/{ticker}")
def clear_cache(ticker: str) -> Dict[str, str]:
    marketstack_service.clear_cache(ticker)
    return {'message': f'Cache cleared for {ticker.upper()}'}
