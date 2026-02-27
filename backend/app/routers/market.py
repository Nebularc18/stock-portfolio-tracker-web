"""Market data API endpoints.

This module provides API endpoints for market index data, exchange rates,
market hours status, and sparkline charts for the header component.
"""

from fastapi import APIRouter, Query
from typing import List
from datetime import datetime, timezone
import requests
import logging

from app.services.market_hours_service import MarketHoursService
from app.services.market_data_service import get_header_market_data

router = APIRouter()
logger = logging.getLogger(__name__)

MARKET_INDICES = {
    "^OMXS30": "OMX Stockholm 30",
    "^OMXS30GI": "OMX Stockholm 30 GI",
    "^OMXSPI": "OMX Stockholm PI",
    "^OMXC25": "OMX Copenhagen 25",
    "^OMXH25": "OMX Helsinki 25",
    "^OSEAX": "Oslo All Share",
    "^GSPC": "S&P 500",
    "^DJI": "Dow Jones",
    "^IXIC": "NASDAQ",
    "^FTSE": "FTSE 100",
    "^GDAXI": "DAX",
    "^STOXX50E": "Euro Stoxx 50",
}

_session = None

def get_session():
    """Get or create a shared requests session with default headers.
    
    Returns:
        requests.Session: Session with User-Agent and Accept headers configured.
    """
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
        })
    return _session


def fetch_index_data(symbol: str) -> dict | None:
    """Fetch current price and change data for a market index.
    
    Args:
        symbol: Yahoo Finance symbol for the index (e.g., '^GSPC' for S&P 500).
    
    Returns:
        dict: Contains symbol, price, change, and change_percent fields.
        None: If data could not be fetched or parsed.
    """
    session = get_session()
    
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
        response = session.get(url, timeout=10)
        
        if response.status_code != 200:
            logger.warning(f"Yahoo returned {response.status_code} for {symbol}")
            return None
        
        data = response.json()
        
        if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
            return None
        
        result = data['chart']['result'][0]
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        meta = result.get('meta', {})
        
        closes = quote.get('close', [])
        prices = [p for p in closes if p is not None]
        
        if len(prices) >= 2:
            current = prices[-1]
            previous = prices[-2]
            change = current - previous
            change_percent = (change / previous) * 100 if previous != 0 else 0
        else:
            current_price = meta.get('regularMarketPrice')
            previous_close = meta.get('chartPreviousClose')
            
            if current_price is None or previous_close is None:
                return None
            
            current = current_price
            change = current_price - previous_close
            change_percent = (change / previous_close) * 100 if previous_close != 0 else 0
        
        return {
            "symbol": symbol,
            "price": current,
            "change": change,
            "change_percent": change_percent,
        }
    except Exception as e:
        logger.error(f"Error fetching {symbol}: {e}")
        return None


@router.get("/header")
def get_header_data(force: bool = Query(False)):
    """Retrieve market data for the header component.
    
    Args:
        force: If True, bypass cache and force refresh.
    
    Returns:
        dict: Header market data with indices and exchange rates.
    """
    return get_header_market_data(force_refresh=force)


@router.get("/should-refresh")
def should_refresh():
    """Check if market data should be refreshed.
    
    Returns:
        dict: Contains 'should_refresh' boolean based on market hours.
    """
    return {"should_refresh": MarketHoursService.should_refresh()}


@router.get("/indices")
def get_market_indices():
    """Retrieve current data for all tracked market indices.
    
    Returns:
        dict: Contains 'indices' list with symbol, name, price, change,
            and change_percent fields, plus 'updated_at' timestamp.
    """
    results = []
    
    for symbol, name in MARKET_INDICES.items():
        data = fetch_index_data(symbol)
        if data:
            results.append({
                **data,
                "name": name,
            })
    
    return {
        "indices": results,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }


@router.get("/exchange-rates")
def get_exchange_rates():
    """Retrieve current exchange rates for major currency pairs.
    
    Returns:
        dict: Mapping of currency pair names to exchange rates
            (e.g., {'USD_SEK': 10.5, 'EUR_SEK': 11.2}).
    """
    session = get_session()
    rates = {}
    
    pairs = [
        ("USDSEK=X", "USD_SEK"),
        ("EURSEK=X", "EUR_SEK"),
        ("SEKUSD=X", "SEK_USD"),
        ("USDEUR=X", "USD_EUR"),
        ("EURUSD=X", "EUR_USD"),
        ("USDGBP=X", "USD_GBP"),
        ("GBPUSD=X", "GBP_USD"),
    ]
    
    for symbol, key in pairs:
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d"
            response = session.get(url, timeout=5)
            
            if response.status_code == 200:
                data = response.json()
                if data.get('chart', {}).get('result'):
                    quote = data['chart']['result'][0].get('indicators', {}).get('quote', [{}])[0]
                    closes = quote.get('close', [])
                    prices = [p for p in closes if p is not None]
                    if prices:
                        rates[key] = prices[-1]
        except Exception:
            continue
    
    return rates


@router.get("/hours")
def get_market_hours(timezone: str = None):
    """Retrieve status for all tracked markets.
    
    Args:
        timezone: Optional timezone for status times (defaults to market local).
    
    Returns:
        dict: Market status for all tracked markets with open/close times.
    """
    return MarketHoursService.get_all_markets_status(timezone)


@router.get("/hours/{market}")
def get_specific_market_hours(market: str, timezone: str = None):
    """Retrieve status for a specific market.
    
    Args:
        market: Market identifier (e.g., 'SE' for Sweden, 'US' for USA).
        timezone: Optional timezone for status times.
    
    Returns:
        dict: Market status with open, close, and is_open fields,
            or error message if market not found.
    """
    status = MarketHoursService.get_market_status(market.upper(), timezone)
    if "error" in status:
        return status
    return status


@router.get("/indices/sparklines")
def get_index_sparklines():
    """Retrieve 30-day price sparkline data for all market indices.
    
    Returns:
        dict: Mapping of index symbols to sparkline data containing
            prices, dates, is_positive, start_value, end_value,
            and change_percent fields.
    """
    session = get_session()
    sparklines = {}
    
    for symbol in MARKET_INDICES.keys():
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=30d"
            response = session.get(url, timeout=10)
            
            if response.status_code != 200:
                continue
            
            data = response.json()
            
            if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
                continue
            
            result = data['chart']['result'][0]
            quote = result.get('indicators', {}).get('quote', [{}])[0]
            timestamps = result.get('timestamp', [])
            closes = quote.get('close', [])
            
            prices = []
            dates = []
            for i, (ts, price) in enumerate(zip(timestamps, closes)):
                if price is not None:
                    prices.append(price)
                    dates.append(datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d'))
            
            if len(prices) >= 2:
                start_price = prices[0]
                end_price = prices[-1]
                change_percent = ((end_price - start_price) / start_price) * 100 if start_price else 0
                
                sparklines[symbol] = {
                    "prices": prices,
                    "dates": dates,
                    "is_positive": end_price >= start_price,
                    "start_value": start_price,
                    "end_value": end_price,
                    "change_percent": change_percent,
                }
        except Exception as e:
            logger.error(f"Error fetching sparkline for {symbol}: {e}")
            continue
    
    return {
        "sparklines": sparklines,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
