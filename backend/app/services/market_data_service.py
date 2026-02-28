"""Market data service for index and exchange rate data.

This module provides functionality to fetch market index data and
exchange rates from Yahoo Finance for display in the application header.
"""

import requests
import json
import os
import time
from datetime import datetime
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
    "^GSPC": "S&P 500",
    "^IXIC": "NASDAQ",
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

def _load_cache(filename: str) -> Optional[Any]:
    """Load cached data from a file if it exists and hasn't expired.
    
    Args:
        filename: Name of the cache file to load.
    
    Returns:
        The cached value if valid, None if expired or not found.
    """
    filepath = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        if datetime.now().timestamp() - data.get('timestamp', 0) < data.get('ttl', 300):
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
    """
    Fetch quote data for the given Yahoo Finance symbols in parallel.
    
    Only successful fetches are included in the returned mapping; symbols that fail to return data are omitted.
    
    Parameters:
        symbols (List[str]): Yahoo Finance symbol strings to fetch.
    
    Returns:
        Dict[str, Dict]: Mapping from symbol to its quote data for each successful fetch.
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

def get_header_market_data(force_refresh: bool = False, selected_indices: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Provide market indices and exchange rates for the application header.
    
    Parameters:
        force_refresh (bool): If True, bypass cached data and fetch fresh quotes.
        selected_indices (Optional[List[str]]): If provided, include only these index symbols in the result.
    
    Returns:
        dict: {
            "indices": List[dict] - each dict contains `symbol` (str), `name` (str), `price` (float), `change` (float), `change_percent` (float);
            "exchange_rates": Dict[str, float] - mapping of currency keys to latest price;
            "updated_at": str - UTC ISO-8601 timestamp ending with 'Z'
        }
    """
    cached = _load_cache('market_header.json')
    if cached is not None and not force_refresh:
        if selected_indices:
            cached['indices'] = [i for i in cached.get('indices', []) if i['symbol'] in selected_indices]
        return cached
    
    all_symbols = list(HEADER_INDICES.keys()) + list(HEADER_FX.keys())
    quotes = _fetch_all_quotes(all_symbols)
    
    indices = []
    for symbol, name in HEADER_INDICES.items():
        if selected_indices and symbol not in selected_indices:
            continue
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
    
    result = {
        'indices': indices,
        'exchange_rates': exchange_rates,
        'updated_at': datetime.utcnow().isoformat() + 'Z',
    }
    
    _save_cache('market_header.json', result, HEADER_CACHE_TTL)
    
    return result
