"""Market data service for index and exchange rate data.

This module provides functionality to fetch market index data and
exchange rates from Yahoo Finance for display in the application header.
"""

import requests
import json
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

HEADER_INDICES = {
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

HEADER_FX = {
    "USDSEK=X": "USD_SEK",
    "EURSEK=X": "EUR_SEK",
}

HEADER_CACHE_TTL = 900

_session = None

def _get_session():
    """Get or create a shared requests session with default headers.
    
    Returns:
        requests.Session: Session configured with User-Agent and headers.
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

def _load_cache(filename: str, include_metadata: bool = False) -> Optional[Any]:
    """Load cached data from a file if it exists and hasn't expired.
    
    Args:
        filename: Name of the cache file to load.
        include_metadata: If True, return dict with 'value', 'timestamp', and 'ttl'.
    
    Returns:
        The cached value if valid, None if expired or not found.
        If include_metadata is True, returns dict with metadata.
    """
    filepath = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        if datetime.now().timestamp() - data.get('timestamp', 0) < data.get('ttl', 300):
            if include_metadata:
                return data
            return data.get('value')
        return None
    except Exception:
        return None

def _save_cache(filename: str, value: Any, ttl: int = 300):
    """Save data to a cache file with a TTL.
    
    Args:
        filename: Name of the cache file to save.
        value: The value to cache.
        ttl: Time-to-live in seconds (default 5 minutes).
    """
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w') as f:
            json.dump({'value': value, 'timestamp': datetime.now().timestamp(), 'ttl': ttl}, f)
    except Exception as e:
        logger.warning(f"Failed to save cache {filename}: {e}")

def _fetch_single_quote(symbol: str) -> Optional[Dict]:
    """Fetch quote data for a single symbol from Yahoo Finance.
    
    Args:
        symbol: Yahoo Finance symbol (e.g., '^GSPC', 'USDSEK=X').
    
    Returns:
        dict: Quote data with price, change, and change_percent,
            or None if fetch fails.
    """
    session = _get_session()
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
    
    try:
        response = session.get(url, timeout=10)
        
        if response.status_code == 429:
            logger.warning(f"Rate limited for {symbol}")
            return None
        
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
        
        current_price = meta.get('regularMarketPrice')
        previous_close = meta.get('chartPreviousClose')
        
        if len(prices) >= 2:
            current = prices[-1]
            previous = prices[-2]
            change = current - previous
            change_percent = (change / previous) * 100 if previous else 0
            
            return {
                'price': current,
                'change': change,
                'change_percent': change_percent,
            }
        elif current_price is not None and previous_close is not None:
            change = current_price - previous_close
            change_percent = (change / previous_close) * 100 if previous_close else 0
            
            return {
                'price': current_price,
                'change': change,
                'change_percent': change_percent,
            }
        elif len(prices) == 1:
            return {
                'price': prices[0],
                'change': 0,
                'change_percent': 0,
            }
        
        return None
        
    except Exception as e:
        logger.error(f"Error fetching {symbol}: {e}")
        return None

def _fetch_all_quotes(symbols: List[str]) -> Dict[str, Dict]:
    """Fetch quote data for multiple symbols in parallel.
    
    Args:
        symbols: List of Yahoo Finance symbols.
    
    Returns:
        dict: Mapping of symbols to quote data.
    """
    if not symbols:
        return {}
    
    results = {}
    
    with ThreadPoolExecutor(max_workers=min(len(symbols), 4)) as executor:
        future_to_symbol = {executor.submit(_fetch_single_quote, symbol): symbol for symbol in symbols}
        
        for future in as_completed(future_to_symbol):
            symbol = future_to_symbol[future]
            try:
                data = future.result()
                if data:
                    results[symbol] = data
            except Exception as e:
                logger.error(f"Error getting result for {symbol}: {e}")
    
    return results

def get_header_market_data(force_refresh: bool = False) -> Dict[str, Any]:
    """Retrieve market data for the header component.
    
    Fetches index and exchange rate data in parallel and caches
    the result for 15 minutes. Returns all indices; filtering
    by user settings is done on the frontend.
    
    Args:
        force_refresh: If True, bypass cache and fetch fresh data.
    
    Returns:
        dict: Contains indices list, exchange_rates dict, updated_at, and next_refresh_at.
    """
    # Check cache with metadata
    cached_data = _load_cache('market_header.json', include_metadata=True)
    if cached_data is not None and not force_refresh:
        cached = cached_data.get('value') if isinstance(cached_data, dict) else None
        if isinstance(cached, dict):
            try:
                cached_at = int(cached_data.get('timestamp', 0))
            except (TypeError, ValueError, AttributeError):
                cached_at = 0

            try:
                ttl = int(cached_data.get('ttl', HEADER_CACHE_TTL))
            except (TypeError, ValueError, AttributeError):
                ttl = HEADER_CACHE_TTL

            if ttl <= 0:
                ttl = HEADER_CACHE_TTL

            next_refresh_at = None
            if cached_at > 0:
                try:
                    next_refresh_at = datetime.fromtimestamp(cached_at + ttl, tz=timezone.utc).isoformat()
                except (OverflowError, OSError, ValueError, TypeError):
                    next_refresh_at = None

            if next_refresh_at is None:
                cached = None

            if isinstance(cached, dict):
                result = {**cached}
                result['next_refresh_at'] = next_refresh_at

                return result
    
    all_symbols = list(HEADER_INDICES.keys()) + list(HEADER_FX.keys())
    quotes = _fetch_all_quotes(all_symbols)
    
    indices = []
    for symbol, name in HEADER_INDICES.items():
        if symbol in quotes:
            data = quotes[symbol]
            indices.append({
                'symbol': symbol,
                'name': name,
                'price': data['price'],
                'change': data['change'],
                'change_percent': data['change_percent'],
            })
    
    exchange_rates = {}
    for symbol, key in HEADER_FX.items():
        if symbol in quotes:
            exchange_rates[key] = quotes[symbol]['price']
    
    now = datetime.now(timezone.utc)
    next_refresh = now + timedelta(seconds=HEADER_CACHE_TTL)
    
    result = {
        'indices': indices,
        'exchange_rates': exchange_rates,
        'updated_at': now.isoformat(),
        'next_refresh_at': next_refresh.isoformat()
    }
    
    _save_cache('market_header.json', result, HEADER_CACHE_TTL)
    
    return result
