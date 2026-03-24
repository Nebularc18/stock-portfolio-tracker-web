"""Market data API endpoints.

This module provides API endpoints for market index data, exchange rates,
market hours status, and sparkline charts for the header component.
"""

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel
from typing import List
from datetime import date, datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import logging
import json
import os
import tempfile
from functools import lru_cache

from app.services.market_hours_service import MarketHoursService
from app.services.market_data_service import get_header_market_data, HEADER_INDICES

router = APIRouter()
logger = logging.getLogger(__name__)

_CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
_DEFAULT_SUPPORTED_EXCHANGE_CURRENCIES = ('SEK', 'USD', 'GBP', 'EUR')
_SUPPORTED_EXCHANGES_PATH = os.getenv(
    'SUPPORTED_EXCHANGES_PATH',
    os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'config', 'supported_exchanges.json')
)


def _get_int_env(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    try:
        return int(raw_value)
    except ValueError:
        logger.warning("Invalid integer for %s=%r; using default %s", name, raw_value, default)
        return default


MAX_EXCHANGE_RATE_SPAN_DAYS = _get_int_env('MARKET_MAX_EXCHANGE_RATE_SPAN_DAYS', 3650)
INDICES_CACHE_TTL = 900  # 15 minutes
EXCHANGE_RATES_CACHE_TTL = _get_int_env('EXCHANGE_RATES_CACHE_TTL', 900)
HISTORICAL_EXCHANGE_RATES_CACHE_TTL = _get_int_env('HISTORICAL_EXCHANGE_RATES_CACHE_TTL', 86400 * 30)
EXCHANGE_RATE_FETCH_WORKERS = _get_int_env('EXCHANGE_RATE_FETCH_WORKERS', 6)
SPARKLINE_SYMBOL_OVERRIDES = {
    "^OMXS30": "^OMX",
}


@lru_cache(maxsize=1)
def _get_supported_exchange_currencies() -> tuple[str, ...]:
    try:
        with open(_SUPPORTED_EXCHANGES_PATH, 'r', encoding='utf-8') as f:
            exchanges = json.load(f)
    except Exception:
        logger.exception("Failed to load supported exchanges from %s", _SUPPORTED_EXCHANGES_PATH)
        exchanges = _DEFAULT_SUPPORTED_EXCHANGE_CURRENCIES

    currencies = []
    seen = set()
    for exchange in exchanges:
        if isinstance(exchange, dict):
            currency = exchange.get('currency')
        elif isinstance(exchange, str):
            currency = exchange
        else:
            continue
        if isinstance(currency, str) and currency and currency not in seen:
            seen.add(currency)
            currencies.append(currency)

    if not currencies:
        logger.warning("No supported exchange currencies found in %s; using fallback currencies", _SUPPORTED_EXCHANGES_PATH)
        return _DEFAULT_SUPPORTED_EXCHANGE_CURRENCIES

    return tuple(currencies)


def _build_exchange_rate_pairs() -> list[tuple[str, str]]:
    currencies = sorted(_get_supported_exchange_currencies())
    return [
        (f"{base}{quote}=X", f"{base}_{quote}")
        for index, base in enumerate(currencies)
        for quote in currencies[index + 1:]
    ]


pairs = _build_exchange_rate_pairs()
_DIRECT_PAIR_SYMBOLS = {key: symbol for symbol, key in pairs}


def _all_rate_keys() -> list[str]:
    keys: list[str] = []
    for _, key in pairs:
        base, quote = key.split('_', 1)
        keys.append(key)
        keys.append(f"{quote}_{base}")
    return keys


def _empty_rate_map() -> dict[str, float | None]:
    return {key: None for key in _all_rate_keys()}


def _empty_rate_map_for_keys(rate_keys: set[str] | None) -> dict[str, float | None]:
    if not rate_keys:
        return _empty_rate_map()
    return {key: None for key in sorted(rate_keys)}


def _store_exchange_rate(rates: dict[str, float | None], key: str, rate: float):
    base, quote = key.split('_', 1)
    reverse_key = f"{quote}_{base}"
    if rate > 0:
        rates[key] = rate
        rates[reverse_key] = 1 / rate
        return

    rates[key] = None
    rates[reverse_key] = None


def _has_resolved_rates(rates: dict[str, float | None]) -> bool:
    return any(value is not None for value in rates.values())


def _has_complete_rates(rates: dict[str, float | None]) -> bool:
    return all(value is not None for value in rates.values())


def _filter_rates(rates: dict[str, float | None], rate_keys: set[str] | None) -> dict[str, float | None]:
    if not rate_keys:
        return dict(rates)
    return {key: rates.get(key) for key in sorted(rate_keys)}


def _normalize_currency_code(value: str) -> str:
    normalized = value.strip().upper()
    if len(normalized) != 3 or not normalized.isalpha():
        raise HTTPException(status_code=400, detail="currencies and target_currency must use 3-letter currency codes")
    return normalized


def _resolve_requested_pair_metadata(
    currencies: list[str] | None,
    target_currency: str | None,
) -> tuple[set[str] | None, list[tuple[str, str]] | None]:
    if not currencies or not target_currency:
        return None, None

    normalized_target = _normalize_currency_code(target_currency)
    normalized_currencies = {
        _normalize_currency_code(currency)
        for currency in currencies
        if currency and _normalize_currency_code(currency) != normalized_target
    }
    if not normalized_currencies:
        return set(), []

    requested_rate_keys: set[str] = set()
    requested_pairs: dict[str, tuple[str, str]] = {}

    for currency in sorted(normalized_currencies):
        direct_key = f"{currency}_{normalized_target}"
        reverse_key = f"{normalized_target}_{currency}"
        requested_rate_keys.add(direct_key)
        requested_rate_keys.add(reverse_key)

        if direct_key in _DIRECT_PAIR_SYMBOLS:
            requested_pairs[direct_key] = (_DIRECT_PAIR_SYMBOLS[direct_key], direct_key)
        elif reverse_key in _DIRECT_PAIR_SYMBOLS:
            requested_pairs[reverse_key] = (_DIRECT_PAIR_SYMBOLS[reverse_key], reverse_key)
        else:
            requested_rate_keys.discard(direct_key)
            requested_rate_keys.discard(reverse_key)

    return requested_rate_keys, list(requested_pairs.values())


def _merge_rates_with_stale_cache(
    cache_key: str,
    ttl: int,
    rates: dict[str, float | None],
) -> dict[str, float | None]:
    cached_snapshot = _load_json_cache(cache_key, ttl, allow_stale=True)
    if cached_snapshot is None:
        return dict(rates)

    merged_rates = dict(rates)
    for key, value in cached_snapshot.items():
        if merged_rates.get(key) is None and value is not None:
            merged_rates[key] = value

    return merged_rates


def _group_consecutive_dates(values: list[tuple[str, date]]) -> list[list[tuple[str, date]]]:
    if not values:
        return []

    sorted_values = sorted(values, key=lambda item: item[1])
    groups: list[list[tuple[str, date]]] = [[sorted_values[0]]]

    for entry in sorted_values[1:]:
        previous_date = groups[-1][-1][1]
        if (entry[1] - previous_date).days == 1:
            groups[-1].append(entry)
        else:
            groups.append([entry])

    return groups


def _validate_exchange_rate_span(start_date: date, end_date: date):
    span_days = (end_date - start_date).days
    if span_days > MAX_EXCHANGE_RATE_SPAN_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"date span must not exceed {MAX_EXCHANGE_RATE_SPAN_DAYS} days",
        )


def _log_non_200_yahoo_response(url: str, response: requests.Response, context: str):
    """
    Log a warning when a Yahoo HTTP request returns a non-200 response.
    
    Parameters:
        url (str): The requested Yahoo URL.
        response (requests.Response): The HTTP response whose status code and body will be logged (body truncated).
        context (str): Short description of the request context (for example symbol or endpoint name).
    """
    logger.warning(
        "Yahoo returned %s for %s (%s): %s",
        response.status_code,
        context,
        url,
        response.text[:200],
    )


def _load_json_cache(filename: str, ttl: int, allow_stale: bool = False) -> dict | None:
    """
    Load a JSON cache file from the module cache directory and return its stored value if not expired.
    
    Parameters:
        filename (str): Name of the cache file inside the cache directory.
        ttl (int): Time-to-live in seconds; the cached entry is considered expired when current UTC time minus `cached_at` is greater than or equal to `ttl`.
    
    Returns:
        dict | None: The cached `value` object from the file if present and not expired, otherwise `None` (also returned on parse or I/O errors).
    """
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, filename)
        if not os.path.exists(filepath):
            return None
        with open(filepath, 'r', encoding='utf-8') as f:
            try:
                payload = json.load(f)
            except json.JSONDecodeError:
                return None
        cached_at = payload.get('cached_at', 0)
        if not allow_stale and datetime.now(timezone.utc).timestamp() - cached_at >= ttl:
            return None
        return payload.get('value')
    except Exception:
        logger.exception("Failed to load cache file %s", filename)
        return None


def _save_json_cache(filename: str, value: dict):
    """
    Write a JSON-serializable mapping to the module cache directory as an atomic cache file with a UTC timestamp.
    
    The function stores `value` under `filename` inside the configured cache directory. The on-disk payload contains two keys: `cached_at` (UTC epoch seconds) and `value` (the provided mapping). The file is written atomically via a temporary file and rename; any I/O or serialization errors are logged and suppressed (no exception is raised).
     
    Parameters:
        filename (str): Name of the cache file to create (relative to the cache directory).
        value (dict): JSON-serializable mapping to persist.
    """
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, filename)
        fd, temp_path = tempfile.mkstemp(dir=_CACHE_DIR, prefix=f"{filename}.", suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({
                    'cached_at': datetime.now(timezone.utc).timestamp(),
                    'value': value,
                }, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, filepath)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
    except Exception:
        logger.exception("Failed to save cache file %s", filename)


def _latest_exchange_rates_cache_key() -> str:
    """
    Return the filename used for caching the latest exchange rates JSON.
    
    Returns:
        cache_filename (str): The relative filename 'exchange_rates_latest.json'.
    """
    return 'exchange_rates_latest.json'


def _historical_exchange_rates_cache_key(target_date: date) -> str:
    """
    Builds the cache filename for historical exchange rates for a specific date.
    
    Parameters:
        target_date (date): The date for which to generate the cache key.
    
    Returns:
        str: Cache filename in the format "exchange_rates_YYYYMMDD.json" (e.g., "exchange_rates_20260311.json").
    """
    return f"exchange_rates_{target_date.isoformat().replace('-', '')}.json"


def _build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    return session


def _fetch_latest_pair_rate(session: requests.Session | None, symbol: str, key: str) -> tuple[str, float | None]:
    """
    Fetches the most recent available daily close price for a given Yahoo Finance exchange-rate symbol.
    
    Parameters:
        symbol (str): Yahoo Finance symbol for the currency pair (e.g., "USDSEK=X").
        key (str): Result mapping key for the pair (e.g., "USD_SEK").
    
    Returns:
        tuple[str, float | None]: A tuple (key, price) where `price` is the most recent daily close as a float, or `None` if no valid price was found.
    """
    active_session = session or _build_session()
    owns_session = session is None

    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d"
        response = active_session.get(url, timeout=5)

        if response.status_code != 200:
            _log_non_200_yahoo_response(url, response, f"exchange rate {key}")
            return key, None

        data = response.json()
        if not data.get('chart', {}).get('result'):
            return key, None

        result = data['chart']['result'][0]
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        closes = quote.get('close', [])
        prices = [price for price in closes if price is not None]
        return key, prices[-1] if prices else None
    finally:
        if owns_session:
            active_session.close()


def _fetch_range_pair_rates(
    session: requests.Session | None,
    symbol: str,
    key: str,
    period_start: datetime,
    period_end: datetime,
) -> tuple[str, list[tuple[date, float]]]:
    """
    Retrieve daily close prices for the given ticker symbol between period_start and period_end.
    
    Parameters:
        session (requests.Session): HTTP session used to perform the request.
        symbol (str): Ticker symbol to fetch historical data for (e.g., "USDSEK=X").
        key (str): Pair key to return alongside the series (e.g., "USD_SEK").
        period_start (datetime): Inclusive start of the requested time range (UTC-aware recommended).
        period_end (datetime): Exclusive end of the requested time range (UTC-aware recommended).
    
    Returns:
        tuple[str, list[tuple[date, float]]]: A tuple whose first element is the provided `key` and whose second element
        is a list of (date, price) pairs for each day in the range with an available close price. Returns an empty list
        when no valid data is available for the symbol in the requested range.
    """
    active_session = session or _build_session()
    owns_session = session is None

    try:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
            f"?period1={int(period_start.timestamp())}&period2={int(period_end.timestamp())}&interval=1d"
        )
        response = active_session.get(url, timeout=5)

        if response.status_code != 200:
            _log_non_200_yahoo_response(url, response, f"exchange rate series {key}")
            return key, []

        data = response.json()
        if not data.get('chart', {}).get('result'):
            return key, []

        result = data['chart']['result'][0]
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        closes = quote.get('close', [])
        timestamps = result.get('timestamp', [])
        return key, [
            (datetime.fromtimestamp(ts, tz=timezone.utc).date(), price)
            for ts, price in zip(timestamps, closes, strict=False)
            if price is not None
        ]
    finally:
        if owns_session:
            active_session.close()


def _fetch_latest_exchange_rates() -> dict[str, float | None]:
    """
    Retrieve the latest exchange rate values for all supported currency pairs.
    
    Returns:
        dict[str, float | None]: A mapping of rate keys to their latest exchange rates or `None` if unavailable.
    """
    cached = _load_json_cache(_latest_exchange_rates_cache_key(), EXCHANGE_RATES_CACHE_TTL)
    if cached is not None:
        return cached

    rates: dict[str, float | None] = _empty_rate_map()

    with ThreadPoolExecutor(max_workers=max(1, min(EXCHANGE_RATE_FETCH_WORKERS, len(pairs)))) as executor:
        futures = {
            executor.submit(_fetch_latest_pair_rate, None, symbol, key): (symbol, key)
            for symbol, key in pairs
        }
        for future in as_completed(futures):
            symbol, key = futures[future]
            try:
                _, rate = future.result()
                if rate is not None:
                    _store_exchange_rate(rates, key, rate)
            except Exception:
                logger.exception("Failed to fetch exchange rate for %s (%s)", key, symbol)

    if _has_resolved_rates(rates):
        merged_rates = _merge_rates_with_stale_cache(
            _latest_exchange_rates_cache_key(),
            EXCHANGE_RATES_CACHE_TTL,
            rates,
        )
        if _has_complete_rates(merged_rates):
            _save_json_cache(_latest_exchange_rates_cache_key(), merged_rates)
        return merged_rates

    cached_snapshot = _load_json_cache(_latest_exchange_rates_cache_key(), EXCHANGE_RATES_CACHE_TTL, allow_stale=True)
    return cached_snapshot if cached_snapshot is not None else rates


def _fetch_exchange_rates_for_range(
    start_date: date,
    end_date: date,
    requested_pairs: list[tuple[str, str]] | None = None,
    requested_rate_keys: set[str] | None = None,
) -> dict[date, dict[str, float | None]]:
    """
    Fetches exchange rates for every date in the inclusive date range and returns a per-day map of rate keys to values.
    
    Parameters:
        start_date (date): Inclusive start of the date range.
        end_date (date): Inclusive end of the date range.
    
    Returns:
        dict[date, dict[str, float | None]]: A mapping where each date in the inclusive range maps to a dictionary of all rate keys (e.g., `USD_SEK`) to their rate value or `None` if unavailable.
    """
    _validate_exchange_rate_span(start_date, end_date)
    effective_pairs = requested_pairs if requested_pairs is not None else pairs
    rates_by_date: dict[date, dict[str, float | None]] = {
        start_date + timedelta(days=offset): _empty_rate_map_for_keys(requested_rate_keys)
        for offset in range((end_date - start_date).days + 1)
    }

    period_start = datetime.combine(start_date - timedelta(days=7), datetime.min.time(), tzinfo=timezone.utc)
    period_end = datetime.combine(end_date + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)

    with ThreadPoolExecutor(max_workers=max(1, min(EXCHANGE_RATE_FETCH_WORKERS, len(effective_pairs)))) as executor:
        futures = {
            executor.submit(_fetch_range_pair_rates, None, symbol, key, period_start, period_end): (symbol, key)
            for symbol, key in effective_pairs
        }
        for future in as_completed(futures):
            symbol, key = futures[future]
            try:
                _, series = future.result()
                if not series:
                    continue

                series_index = 0
                latest_price = None
                for current_date in sorted(rates_by_date):
                    while series_index < len(series) and series[series_index][0] <= current_date:
                        latest_price = series[series_index][1]
                        series_index += 1
                    if latest_price is not None:
                        _store_exchange_rate(rates_by_date[current_date], key, latest_price)
            except Exception:
                logger.exception("Failed to fetch exchange rate series for %s (%s)", key, symbol)

    return rates_by_date


def _fetch_exchange_rates_for_date(target_date: date | None, allow_stale: bool = False) -> dict[str, float | None]:
    """
    Retrieve exchange rates for a specific date, or the latest rates when no date is provided.
    
    Parameters:
        target_date (date | None): The ISO date to retrieve historical rates for; if None, the current/latest rates are returned.
    
    Returns:
        dict[str, float | None]: A mapping from rate key (e.g., "USD_SEK") to the exchange rate as a float, or `None` if no valid rate is available for that key.
    """
    if target_date is None:
        return _fetch_latest_exchange_rates()

    cached = _load_json_cache(
        _historical_exchange_rates_cache_key(target_date),
        HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
        allow_stale=allow_stale,
    )
    if cached is not None:
        return cached

    rates = _fetch_exchange_rates_for_range(target_date, target_date).get(
        target_date,
        _empty_rate_map(),
    )
    if _has_resolved_rates(rates):
        merged_rates = _merge_rates_with_stale_cache(
            _historical_exchange_rates_cache_key(target_date),
            HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
            rates,
        )
        if _has_complete_rates(merged_rates):
            _save_json_cache(_historical_exchange_rates_cache_key(target_date), merged_rates)
        return merged_rates

    cached_snapshot = _load_json_cache(
        _historical_exchange_rates_cache_key(target_date),
        HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
        allow_stale=True,
    )
    if cached_snapshot is not None:
        return cached_snapshot
    return rates

def get_session():
    """Create a requests session with default headers.
    
    Returns:
        requests.Session: Session with User-Agent and Accept headers configured.
    """
    return _build_session()


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


def fetch_index_data(symbol: str, session: requests.Session) -> dict | None:
    """
    Retrieve the latest price and percentage change for a market index from Yahoo Finance.
    
    Parameters:
        symbol (str): Yahoo Finance symbol for the index (for example, '^GSPC').
    
    Returns:
        dict: Mapping with keys 'symbol' (str), 'price' (number), 'change' (number), and 'change_percent' (number).
        None: If the data could not be fetched or parsed.
    """
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
    session = get_session()
    try:
        for symbol, name in HEADER_INDICES.items():
            data = fetch_index_data(symbol, session)
            if data:
                results.append({
                    **data,
                    "name": name,
                })
    finally:
        session.close()
    
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
    if date is not None:
        if date == '':
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format") from exc
        return _fetch_exchange_rates_for_date(target_date)

    return _fetch_exchange_rates_for_date(None)


class ExchangeRatesBatchRequest(BaseModel):
    dates: List[str]
    currencies: List[str] | None = None
    target_currency: str | None = None


@router.post("/exchange-rates/batch")
def get_exchange_rates_batch(payload: ExchangeRatesBatchRequest = Body(...)):
    """
    Return exchange rate maps for multiple ISO date strings provided in the request body.
    
    Parses each input string as YYYY-MM-DD and returns a mapping from the original input string to a per-rate-key mapping of exchange rates (float) or None when a rate is unavailable. Cached per-date results are used when available; missing dates are fetched as a contiguous range and cached.
    
    Parameters:
        dates (List[str]): List of date strings in the format "YYYY-MM-DD" provided in the request body.
    
    Returns:
        dict[str, dict[str, float | None]]: Mapping from each input date string to a map of rate keys (e.g., "USD_SEK") to their rate value or `None`.
    
    Raises:
        HTTPException: If any input date is not a valid YYYY-MM-DD string (status code 400).
    """
    dates = payload.dates
    requested_rate_keys, requested_pairs = _resolve_requested_pair_metadata(payload.currencies, payload.target_currency)

    if not dates:
        return {}

    parsed_dates: list[tuple[str, date]] = []
    rates_by_date: dict[str, dict[str, float | None]] = {}
    missing_dates: list[tuple[str, date]] = []

    for value in dates:
        try:
            target_date = datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="dates must contain YYYY-MM-DD values") from exc

        parsed_dates.append((value, target_date))

        cached = _load_json_cache(
            _historical_exchange_rates_cache_key(target_date),
            HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
        )
        if cached is not None:
            rates_by_date[value] = _filter_rates(cached, requested_rate_keys)
        else:
            missing_dates.append((value, target_date))

    if not missing_dates:
        return rates_by_date

    for group in _group_consecutive_dates(missing_dates):
        start_date = group[0][1]
        end_date = group[-1][1]
        _validate_exchange_rate_span(start_date, end_date)

        range_rates = _fetch_exchange_rates_for_range(
            start_date,
            end_date,
            requested_pairs=requested_pairs,
            requested_rate_keys=requested_rate_keys,
        )

        for original_value, target_date in group:
            cache_key = _historical_exchange_rates_cache_key(target_date)
            daily_rates = range_rates.get(target_date, _empty_rate_map_for_keys(requested_rate_keys))
            if _has_resolved_rates(daily_rates):
                if requested_rate_keys:
                    stale_rates = _load_json_cache(
                        cache_key,
                        HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
                        allow_stale=True,
                    )
                    if stale_rates is not None:
                        daily_rates = _filter_rates(
                            _merge_rates_with_stale_cache(
                                cache_key,
                                HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
                                {**stale_rates, **daily_rates},
                            ),
                            requested_rate_keys,
                        )
                else:
                    daily_rates = _merge_rates_with_stale_cache(
                        cache_key,
                        HISTORICAL_EXCHANGE_RATES_CACHE_TTL,
                        daily_rates,
                    )
                    if _has_complete_rates(daily_rates):
                        _save_json_cache(cache_key, daily_rates)
            else:
                stale_rates = _fetch_exchange_rates_for_date(target_date, allow_stale=True)
                if _has_resolved_rates(stale_rates):
                    daily_rates = _filter_rates(stale_rates, requested_rate_keys)

            rates_by_date[original_value] = daily_rates

    return rates_by_date


@router.get("/hours")
def get_market_hours(timezone: str | None = None):
    """Retrieve status for all tracked markets.
    
    Args:
        timezone: Optional timezone for status times (defaults to market local).
    
    Returns:
        dict: Market status for all tracked markets with open/close times.
    """
    return MarketHoursService.get_all_markets_status(timezone)


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
    return MarketHoursService.get_market_status(market.upper(), timezone)


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

    def fetch_chart_series(symbol: str, interval: str, range_value: str) -> tuple[list[float], list[str]]:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}&range={range_value}"
        response = session.get(url, timeout=10)

        if response.status_code != 200:
            return [], []

        data = response.json()
        if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
            return [], []

        result = data['chart']['result'][0]
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        timestamps = result.get('timestamp', [])
        closes = quote.get('close', [])

        prices: list[float] = []
        dates: list[str] = []
        for ts, price in zip(timestamps, closes, strict=False):
            if price is None:
                continue
            prices.append(price)
            dates.append(datetime.fromtimestamp(ts, tz=timezone.utc).isoformat())

        return prices, dates
    
    try:
        for symbol in HEADER_INDICES.keys():
            try:
                chart_symbol = SPARKLINE_SYMBOL_OVERRIDES.get(symbol, symbol)
                prices, dates = fetch_chart_series(chart_symbol, "1d", "30d")
                if len(prices) < 2:
                    prices, dates = fetch_chart_series(chart_symbol, "5m", "1d")

                if len(prices) < 2:
                    continue

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
            except Exception:
                logger.exception("Error fetching sparkline for %s", symbol)
                continue
    finally:
        session.close()
    
    return {
        "sparklines": sparklines,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
