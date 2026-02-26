"""Marketstack API proxy endpoints.

This module provides API endpoints that proxy requests to the Marketstack
API for dividend data and verification, with usage tracking and caching.
"""

from fastapi import APIRouter, HTTPException
from typing import Optional, Dict, Any, List

from app.services.marketstack_service import marketstack_service, FetchError
from app.services.stock_service import StockService

router = APIRouter()
stock_service = StockService()


@router.get("/status")
def get_status() -> Dict[str, Any]:
    """Retrieve Marketstack API usage status.
    
    Returns:
        dict: Usage status with month, calls_used, calls_limit,
            calls_remaining, and api_configured fields.
    """
    return marketstack_service.get_usage_status()


@router.get("/dividends/{ticker}")
def get_dividends(
    ticker: str,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    use_cache: bool = True
) -> Dict[str, Any]:
    """Retrieve dividend data from Marketstack for a ticker.
    
    Args:
        ticker: Stock ticker symbol.
        date_from: Start date in YYYY-MM-DD format (optional).
        date_to: End date in YYYY-MM-DD format (optional).
        use_cache: Whether to use cached data if available.
    
    Returns:
        dict: Contains ticker, dividends list, count, and usage status.
    
    Raises:
        HTTPException: 503 if API not configured, 429 if rate limited,
            404 if no data found.
    """
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
    """Verify Yahoo Finance dividends against Marketstack data.
    
    Fetches dividend data from both sources and compares them to
    identify discrepancies in amounts or missing records.
    
    Args:
        ticker: Stock ticker symbol.
        use_cache: Whether to use cached verification results.
    
    Returns:
        dict: Contains ticker, verified_at, cached flag, summary counts,
            yahoo_dividends, marketstack_dividends, discrepancies, and usage.
    
    Raises:
        HTTPException: 503 if API not configured, 429 if rate limited.
    """
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
    """Clear cached Marketstack data for a specific ticker.
    
    Args:
        ticker: Stock ticker symbol to clear cache for.
    
    Returns:
        dict: Confirmation message.
    """
    marketstack_service.clear_cache(ticker)
    return {'message': f'Cache cleared for {ticker.upper()}'}
