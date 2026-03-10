"""Market data API endpoints.

This module provides API endpoints for market index data, exchange rates,
market hours status, and sparkline charts for the header component.
"""

from fastapi import APIRouter, HTTPException, Query
from typing import List
from datetime import datetime, timezone, timedelta
import requests
import logging
import json
import os

from app.services.market_hours_service import MarketHoursService
from app.services.market_data_service import get_header_market_data, HEADER_INDICES

router = APIRouter()
logger = logging.getLogger(__name__)

_session = None
_CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
INDICES_CACHE_TTL = 900  # 15 minutes

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


def _load_indices_cache() -> dict | None:
    """
    Return cached market indices data if it exists and is still valid.
    
    Validates the cache's timestamp against its TTL and yields the stored payload when not expired. Returns None when the cache file is missing, expired, unreadable, or an error occurs while accessing it.
    
    Returns:
        dict: Cached payload containing keys such as `indices`, `cached_at`, and `ttl`, or `None` if no valid cache is available.
    """
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, 'market_indices.json')
        if not os.path.exists(filepath):
            return None
        with open(filepath, 'r') as f:
            data = json.load(f)
        cached_at = data.get('cached_at', 0)
        if datetime.now(timezone.utc).timestamp() - cached_at < data.get('ttl', INDICES_CACHE_TTL):
            return data
        return None
    except OSError as e:
        logger.warning(f"Failed to read indices cache due to filesystem error: {e}")
        return None
    except Exception:
        return None


def _save_indices_cache(data: dict):
    """
    Persist indices data to the filesystem cache at _CACHE_DIR/market_indices.json.
    
    Adds `cached_at` (UTC POSIX timestamp) and `ttl` (seconds) to the payload before writing. Ensures the cache directory exists. Filesystem or other errors are logged and suppressed; the function does not raise on failure.
    
    Parameters:
    	data (dict): Payload containing indices data to persist to cache.
    """
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, 'market_indices.json')
        cache_data = {**data}
        cache_data['cached_at'] = datetime.now(timezone.utc).timestamp()
        cache_data['ttl'] = INDICES_CACHE_TTL
        with open(filepath, 'w') as f:
            json.dump(cache_data, f)
    except OSError as e:
        logger.warning(f"Failed to save indices cache due to filesystem error: {e}")
    except Exception as e:
        logger.warning(f"Failed to save indices cache: {e}")


def fetch_index_data(symbol: str) -> dict | None:
    """
    Retrieve the latest price and percentage change for a market index from Yahoo Finance.
    
    Parameters:
        symbol (str): Yahoo Finance symbol for the index (for example, '^GSPC').
    
    Returns:
        dict: Mapping with keys 'symbol' (str), 'price' (number), 'change' (number), and 'change_percent' (number).
        None: If the data could not be fetched or parsed.
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
        dict: Header market data with all indices and exchange rates.
            Filtering by user settings is done on the frontend.
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
    """
    Retrieve current market data for all tracked indices.
    
    Uses a filesystem-backed cache (15-minute TTL). On a valid cache hit returns cached indices and their next refresh time; on a cache miss fetches fresh data, caches it, and returns the new payload.
    
    Returns:
        dict: {
            "indices": list of objects each containing `symbol`, `name`, `price`, `change`, and `change_percent`;
            "updated_at": ISO 8601 UTC timestamp string when the data was produced;
            "next_refresh_at": ISO 8601 UTC timestamp string indicating when the data should be refreshed
        }
    """
    # Check cache first
    cached = _load_indices_cache()
    if cached is not None:
        cached_at = cached.get('cached_at')
        ttl = cached.get('ttl', INDICES_CACHE_TTL)
        if isinstance(cached_at, (int, float)) and isinstance(ttl, (int, float)) and ttl > 0:
            next_refresh = datetime.fromtimestamp(cached_at + ttl, tz=timezone.utc)
        else:
            next_refresh = datetime.now(timezone.utc) + timedelta(seconds=INDICES_CACHE_TTL)
        return {
            "indices": cached.get('indices', []),
            "updated_at": cached.get('updated_at'),
            "next_refresh_at": next_refresh.isoformat()
        }
    
    # Fetch fresh data
    results = []
    
    for symbol, name in HEADER_INDICES.items():
        data = fetch_index_data(symbol)
        if data:
            results.append({
                **data,
                "name": name,
            })
    
    now = datetime.now(timezone.utc)
    next_refresh = now + timedelta(seconds=INDICES_CACHE_TTL)
    
    result = {
        "indices": results,
        "updated_at": now.isoformat(),
        "next_refresh_at": next_refresh.isoformat()
    }
    
    # Keep previous cache intact when upstream temporarily returns no data.
    if results:
        _save_indices_cache(result)
    else:
        logger.warning("Skipping indices cache write because fetched result set was empty")
    
    return result


@router.get("/exchange-rates")
def get_exchange_rates(date: str | None = Query(None)):
    """
    Retrieve exchange rates for major currency pairs, optionally for a specific ISO date.
    
    When no date is provided, returns the most recent available rate for each pair. When a date (YYYY-MM-DD) is provided, returns the latest available rate on or before that date within the fetched window.
    
    Parameters:
        date (str | None): Optional target date in `YYYY-MM-DD` format to fetch historical rates.
    
    Returns:
        dict: Mapping of currency pair keys (e.g., `USD_SEK`, `EUR_USD`) to numeric exchange rates.
    
    Raises:
        HTTPException: If `date` is provided but not in `YYYY-MM-DD` format (HTTP 400).
    """
    session = get_session()
    rates = {}

    target_date = None
    if date:
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format") from exc
    
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
        rates[key] = None
        try:
            if target_date is None:
                url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d"
            else:
                period_start = datetime.combine(target_date - timedelta(days=7), datetime.min.time(), tzinfo=timezone.utc)
                period_end = datetime.combine(target_date + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
                url = (
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
                    f"?period1={int(period_start.timestamp())}&period2={int(period_end.timestamp())}&interval=1d"
                )
            response = session.get(url, timeout=5)
            
            if response.status_code == 200:
                data = response.json()
                if data.get('chart', {}).get('result'):
                    result = data['chart']['result'][0]
                    quote = result.get('indicators', {}).get('quote', [{}])[0]
                    closes = quote.get('close', [])
                    if target_date is None:
                        prices = [p for p in closes if p is not None]
                        if prices:
                            rates[key] = prices[-1]
                        continue

                    timestamps = result.get('timestamp', [])
                    price_for_date = None
                    for ts, price in zip(timestamps, closes):
                        if price is None:
                            continue
                        quote_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()
                        if quote_date <= target_date:
                            price_for_date = price
                    if price_for_date is not None:
                        rates[key] = price_for_date
        except Exception as exc:
            logger.exception("Failed to fetch exchange rate for %s (%s): %s", key, symbol, exc)
            continue
    
    return rates


@router.get("/hours")
def get_market_hours(timezone: str | None = None):
    """Retrieve status for all tracked markets.
    
    Args:
        timezone: Optional timezone for status times (defaults to market local).
    
    Returns:
        dict: Market status for all tracked markets with open/close times.
    """
    return MarketHoursService.get_all_markets_status(timezone or "")


@router.get("/hours/{market}")
def get_specific_market_hours(market: str, timezone: str | None = None):
    """
    Retrieve the trading hours status for a single market.
    
    Parameters:
        market (str): Market identifier (e.g., "SE" for Sweden, "US" for United States).
        timezone (str | None): Optional IANA timezone name to localize reported times.
    
    Returns:
        dict: On success, a mapping with keys such as `open`, `close`, and `is_open` (`true` if the market is currently open, `false` otherwise). If the market is not found or an error occurs, returns a dict containing an `error` key with diagnostic information.
    """
    status = MarketHoursService.get_market_status(market.upper(), timezone or "")
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
    
    for symbol in HEADER_INDICES.keys():
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
