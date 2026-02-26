"""Marketstack API service for dividend data.

This module provides functionality to fetch dividend data from the
Marketstack API, verify dividend data against Yahoo Finance, and
manage API usage limits with caching support.
"""

import os
import requests
import time
import json
import logging
import threading
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

MONTHLY_CALL_LIMIT = 100
VERIFICATION_CACHE_TTL = 86400 * 30
DAILY_DIVIDEND_CACHE_TTL = 86400
USAGE_FILE = "marketstack_usage.json"

_usage_lock = threading.Lock()


@dataclass
class DividendData:
    """Data class representing dividend information.
    
    Attributes:
        date: Dividend ex-date in YYYY-MM-DD format.
        amount: Dividend amount per share.
        currency: Currency code (e.g., 'USD'), or None if unknown.
    """
    date: str
    amount: float
    currency: Optional[str] = None


class FetchError(Exception):
    """Exception raised when API fetch fails.
    
    Attributes:
        message: Error description.
        status_code: HTTP status code (default 500).
    """
    def __init__(self, message: str, status_code: int = 500):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass
class Discrepancy:
    """Data class representing a dividend discrepancy.
    
    Attributes:
        date: Dividend date in YYYY-MM-DD format.
        type: Type of discrepancy (e.g., 'amount_mismatch').
        yahoo_amount: Dividend amount from Yahoo Finance.
        marketstack_amount: Dividend amount from Marketstack.
        difference: Absolute difference between amounts.
    """
    date: str
    type: str
    yahoo_amount: Optional[float]
    marketstack_amount: Optional[float]
    difference: Optional[float]


@dataclass
class VerificationResult:
    """Data class representing dividend verification results.
    
    Attributes:
        ticker: Stock ticker symbol.
        yahoo_dividends: List of dividends from Yahoo Finance.
        marketstack_dividends: List of dividends from Marketstack.
        discrepancies: List of discrepancies found.
        verified_at: ISO timestamp of verification.
        yahoo_count: Number of Yahoo dividends.
        marketstack_count: Number of Marketstack dividends.
        match_count: Number of matching dividends.
        discrepancy_count: Number of discrepancies.
        calls_used: Number of API calls used.
        cached: Whether result was loaded from cache.
    """
    ticker: str
    yahoo_dividends: List[Dict[str, Any]]
    marketstack_dividends: List[Dict[str, Any]]
    discrepancies: List[Dict[str, Any]]
    verified_at: str
    yahoo_count: int
    marketstack_count: int
    match_count: int
    discrepancy_count: int
    calls_used: int
    cached: bool = False


def _load_file_cache(filename: str) -> Optional[Any]:
    """Load cached data from a file if it exists and hasn't expired.
    
    Args:
        filename: Name of the cache file to load.
    
    Returns:
        The cached value if valid and not expired, None otherwise.
    """
    filepath = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse cache file {filename}: {e}")
        return None
    except OSError as e:
        logger.error(f"Failed to read cache file {filepath}: {e}")
        return None
    
    if time.time() - data.get('timestamp', 0) < data.get('ttl', 3600):
        return data.get('value')
    return None


def _save_file_cache(filename: str, value: Any, ttl: int = 3600):
    """Save data to a cache file with a time-to-live.
    
    Args:
        filename: Name of the cache file to save.
        value: The value to cache.
        ttl: Time-to-live in seconds (default 1 hour).
    """
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        cache_data = {'value': value, 'timestamp': time.time(), 'ttl': ttl}
    except (TypeError, ValueError) as e:
        logger.warning(f"Failed to serialize cache data for {filename}: {e}")
        return
    
    try:
        with open(filepath, 'w') as f:
            json.dump(cache_data, f)
    except OSError as e:
        logger.error(f"Failed to write cache file {filepath}: {e}")


def _load_usage() -> Dict[str, Any]:
    """Load API usage data from file.
    
    Returns:
        dict: Usage data with 'month' and 'calls_used' keys.
    """
    filepath = os.path.join(CACHE_DIR, USAGE_FILE)
    if not os.path.exists(filepath):
        return {'month': datetime.now().strftime('%Y-%m'), 'calls_used': 0}
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to load usage file: {e}")
        return {'month': datetime.now().strftime('%Y-%m'), 'calls_used': 0}
    
    current_month = datetime.now().strftime('%Y-%m')
    if data.get('month') != current_month:
        return {'month': current_month, 'calls_used': 0}
    return data


def _save_usage(usage: Dict[str, Any]):
    """Save API usage data to file.
    
    Args:
        usage: Usage dictionary with 'month' and 'calls_used' keys.
    """
    filepath = os.path.join(CACHE_DIR, USAGE_FILE)
    try:
        with open(filepath, 'w') as f:
            json.dump(usage, f)
    except (OSError, TypeError) as e:
        logger.warning(f"Failed to save usage file: {e}")


def _decrement_usage() -> int:
    """Decrement the API call count by one.
    
    Returns:
        int: The new call count after decrementing.
    """
    with _usage_lock:
        usage = _load_usage()
        usage['calls_used'] = max(0, usage.get('calls_used', 0) - 1)
        _save_usage(usage)
        return usage['calls_used']


def try_consume_call() -> bool:
    """Attempt to consume an API call if under the monthly limit.
    
    Returns:
        bool: True if a call was successfully consumed, False if limit reached.
    """
    with _usage_lock:
        usage = _load_usage()
        current = usage.get('calls_used', 0)
        if current >= MONTHLY_CALL_LIMIT:
            return False
        usage['calls_used'] = current + 1
        _save_usage(usage)
        return True


def get_remaining_calls() -> int:
    """Get the number of remaining API calls for the current month.
    
    Returns:
        int: Number of remaining calls (minimum 0).
    """
    with _usage_lock:
        usage = _load_usage()
        return max(0, MONTHLY_CALL_LIMIT - usage.get('calls_used', 0))


class MarketstackService:
    """Service for interacting with the Marketstack API.
    
    Provides methods to fetch dividend data, verify dividends against
    Yahoo Finance, and manage API usage and caching.
    
    Attributes:
        base_url: Base URL for Marketstack API.
    """
    
    def __init__(self):
        """Initialize MarketstackService with API configuration."""
        self.base_url = "https://api.marketstack.com/v2"
    
    @property
    def api_key(self) -> Optional[str]:
        """Get the Marketstack API key from environment.
        
        Returns:
            str or None: The API key if set, None otherwise.
        """
        return os.environ.get('MARKETSTACK_API_KEY')
    
    def is_configured(self) -> bool:
        """Check if the Marketstack API key is configured.
        
        Returns:
            bool: True if API key is set, False otherwise.
        """
        return bool(self.api_key)
    
    def _make_request(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Optional[Any]:
        """Make an authenticated request to the Marketstack API.
        
        Args:
            endpoint: API endpoint path (e.g., 'dividends').
            params: Optional query parameters.
        
        Returns:
            JSON response data, or None if request fails.
        
        Raises:
            FetchError: If API key not configured, rate limit reached,
                or other API error.
        """
        if not self.api_key:
            raise FetchError("Marketstack API key not configured", 503)
        
        if not try_consume_call():
            raise FetchError("Monthly API limit reached", 429)
        
        params = params or {}
        params['access_key'] = self.api_key
        
        try:
            url = f"{self.base_url}/{endpoint}"
            response = requests.get(url, params=params, timeout=15)
            
            if response.status_code == 429:
                _decrement_usage()
                raise FetchError("Marketstack rate limit reached", 429)
            
            if response.status_code in (404, 422):
                _decrement_usage()
                return None
            
            if response.status_code != 200:
                _decrement_usage()
                raise FetchError(f"Marketstack API error: {response.status_code}", 502)
            
            return response.json()
            
        except FetchError:
            raise
        except Exception as e:
            _decrement_usage()
            raise FetchError(f"Marketstack request failed: {e}", 502) from e
    
    def fetch_dividends(
        self, 
        ticker: str, 
        date_from: Optional[str] = None, 
        date_to: Optional[str] = None,
        use_cache: bool = True
    ) -> Optional[List[DividendData]]:
        """Fetch dividend data for a ticker from Marketstack.
        
        Args:
            ticker: Stock ticker symbol.
            date_from: Start date in YYYY-MM-DD format (default: 1 year ago).
            date_to: End date in YYYY-MM-DD format (default: today).
            use_cache: Whether to use cached data if available.
        
        Returns:
            list: List of DividendData objects, or None if fetch fails.
        """
        ticker_upper = ticker.upper()
        sanitized_ticker = ticker_upper.replace('-', '_')
        
        effective_date_from = date_from
        if not effective_date_from:
            effective_date_from = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')
        
        effective_date_to = date_to or ''
        
        date_from_normalized = effective_date_from.replace('-', '')
        date_to_normalized = effective_date_to.replace('-', '')
        cache_key = f"{sanitized_ticker}_{date_from_normalized}_{date_to_normalized}"
        cache_file = f"marketstack_dividends_{cache_key}.json"
        
        if use_cache:
            cached = _load_file_cache(cache_file)
            if cached is not None:
                return [DividendData(**d) for d in cached]
        
        params = {'symbols': ticker_upper}
        params['date_from'] = effective_date_from
        
        if date_to:
            params['date_to'] = date_to
        
        data = self._make_request("dividends", params)
        
        if not data or 'data' not in data:
            return None
        
        dividends = []
        for item in data.get('data', []):
            dividends.append(DividendData(
                date=item.get('date', '')[:10] if item.get('date') else '',
                amount=item.get('dividend', 0),
                currency=None
            ))
        
        dividends.sort(key=lambda x: x.date, reverse=True)
        
        _save_file_cache(cache_file, [asdict(d) for d in dividends], DAILY_DIVIDEND_CACHE_TTL)
        
        return dividends
    
    def verify_dividends(
        self, 
        ticker: str, 
        yahoo_dividends: List[Dict[str, Any]],
        use_cache: bool = True
    ) -> VerificationResult:
        """Verify Yahoo Finance dividends against Marketstack data.
        
        Compares dividend data from both sources and identifies
        discrepancies including amount mismatches and missing data.
        
        Args:
            ticker: Stock ticker symbol.
            yahoo_dividends: List of dividend records from Yahoo Finance.
            use_cache: Whether to use cached verification results.
        
        Returns:
            VerificationResult: Verification results with matches and discrepancies.
        """
        ticker_upper = ticker.upper()
        sanitized_ticker = ticker_upper.replace('-', '_')
        yahoo_hash = hashlib.sha256(
            json.dumps(yahoo_dividends, sort_keys=True).encode()
        ).hexdigest()[:8]
        cache_file = f"marketstack_verify_{sanitized_ticker}_{yahoo_hash}.json"
        
        if use_cache:
            cached = _load_file_cache(cache_file)
            if cached is not None:
                return VerificationResult(
                    ticker=cached['ticker'],
                    yahoo_dividends=cached['yahoo_dividends'],
                    marketstack_dividends=cached['marketstack_dividends'],
                    discrepancies=cached['discrepancies'],
                    verified_at=cached['verified_at'],
                    yahoo_count=cached['yahoo_count'],
                    marketstack_count=cached['marketstack_count'],
                    match_count=cached['match_count'],
                    discrepancy_count=cached['discrepancy_count'],
                    calls_used=0,
                    cached=True
                )
        
        marketstack_divs = self.fetch_dividends(ticker_upper, use_cache=False)
        
        if marketstack_divs is None:
            return VerificationResult(
                ticker=ticker_upper,
                yahoo_dividends=yahoo_dividends,
                marketstack_dividends=[],
                discrepancies=[{
                    'date': '',
                    'type': 'api_error',
                    'yahoo_amount': None,
                    'marketstack_amount': None,
                    'difference': None,
                    'message': 'Failed to fetch data from Marketstack'
                }],
                verified_at=datetime.now(timezone.utc).isoformat(),
                yahoo_count=len(yahoo_dividends),
                marketstack_count=0,
                match_count=0,
                discrepancy_count=1,
                calls_used=1 if self.is_configured() else 0
            )
        
        yahoo_by_date = {}
        for div in yahoo_dividends:
            date = div.get('date', '')
            if date:
                yahoo_by_date[date] = div.get('amount', 0)
        
        marketstack_by_date = {}
        for div in marketstack_divs:
            marketstack_by_date[div.date] = div.amount
        
        discrepancies = []
        match_count = 0
        
        all_dates = set(yahoo_by_date.keys()) | set(marketstack_by_date.keys())
        
        for date in sorted(all_dates, reverse=True):
            yahoo_amount = yahoo_by_date.get(date)
            marketstack_amount = marketstack_by_date.get(date)
            
            if yahoo_amount is not None and marketstack_amount is not None:
                if abs(yahoo_amount - marketstack_amount) > 0.001:
                    discrepancies.append({
                        'date': date,
                        'type': 'amount_mismatch',
                        'yahoo_amount': yahoo_amount,
                        'marketstack_amount': marketstack_amount,
                        'difference': abs(yahoo_amount - marketstack_amount)
                    })
                else:
                    match_count += 1
            elif yahoo_amount is not None:
                discrepancies.append({
                    'date': date,
                    'type': 'missing_from_marketstack',
                    'yahoo_amount': yahoo_amount,
                    'marketstack_amount': None,
                    'difference': None
                })
            else:
                discrepancies.append({
                    'date': date,
                    'type': 'missing_from_yahoo',
                    'yahoo_amount': None,
                    'marketstack_amount': marketstack_amount,
                    'difference': None
                })
        
        result = VerificationResult(
            ticker=ticker_upper,
            yahoo_dividends=yahoo_dividends,
            marketstack_dividends=[asdict(d) for d in marketstack_divs],
            discrepancies=discrepancies,
            verified_at=datetime.now(timezone.utc).isoformat(),
            yahoo_count=len(yahoo_dividends),
            marketstack_count=len(marketstack_divs),
            match_count=match_count,
            discrepancy_count=len(discrepancies),
            calls_used=1
        )
        
        _save_file_cache(cache_file, asdict(result), VERIFICATION_CACHE_TTL)
        
        return result
    
    def get_usage_status(self) -> Dict[str, Any]:
        """Get current API usage status.
        
        Returns:
            dict: Usage status with month, calls_used, calls_limit,
                calls_remaining, and api_configured fields.
        """
        with _usage_lock:
            usage = _load_usage()
            calls_used = usage.get('calls_used', 0)
            remaining = max(0, MONTHLY_CALL_LIMIT - calls_used)
            
            return {
                'month': usage.get('month'),
                'calls_used': calls_used,
                'calls_limit': MONTHLY_CALL_LIMIT,
                'calls_remaining': remaining,
                'api_configured': self.is_configured()
            }
    
    def clear_cache(self, ticker: Optional[str] = None):
        """Clear cached data for a specific ticker or all tickers.
        
        Args:
            ticker: Specific ticker to clear cache for, or None to clear all.
        
        Returns:
            int: Number of cache files cleared.
        """
        cleared_count = 0
        if ticker:
            ticker_upper = ticker.upper()
            sanitized_ticker = ticker_upper.replace('-', '_')
            dividends_prefix = f"marketstack_dividends_{sanitized_ticker}_"
            verify_prefix = f"marketstack_verify_{sanitized_ticker}_"
            for filename in os.listdir(CACHE_DIR):
                if filename == USAGE_FILE:
                    continue
                if filename.startswith(dividends_prefix) or filename.startswith(verify_prefix):
                    filepath = os.path.join(CACHE_DIR, filename)
                    try:
                        os.remove(filepath)
                        cleared_count += 1
                    except OSError as e:
                        logger.warning(f"Failed to delete cache file {filepath}: {e}")
        else:
            for filename in os.listdir(CACHE_DIR):
                if filename == USAGE_FILE:
                    continue
                if 'marketstack' not in filename:
                    continue
                filepath = os.path.join(CACHE_DIR, filename)
                try:
                    os.remove(filepath)
                    cleared_count += 1
                except OSError as e:
                    logger.warning(f"Failed to delete cache file {filepath}: {e}")
        logger.info(f"Cleared {cleared_count} marketstack cache files")
        return cleared_count


marketstack_service = MarketstackService()
