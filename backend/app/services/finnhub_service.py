"""Finnhub API service for company and financial data.

This module provides functionality to fetch company profiles, financial
metrics, peer companies, and analyst recommendations from the Finnhub API
with caching support.
"""

import os
import requests
import time
import json
import logging
from typing import Optional, Dict, Any, List, Tuple

from app.services.env_utils import parse_float_env

logger = logging.getLogger(__name__)
SLOW_FINNHUB_REQUEST_MS = parse_float_env('SLOW_FINNHUB_REQUEST_MS', 800.0, logger)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

def _load_file_cache(filename: str) -> Optional[Any]:
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
        if time.time() - data.get('timestamp', 0) < data.get('ttl', 3600):
            return data.get('value')
        return None
    except Exception as e:
        logger.warning(f"Failed to load cache file {filename}: {e}")
        return None

def _save_file_cache(filename: str, value: Any, ttl: int = 3600):
    """Save data to a cache file with a TTL.
    
    Args:
        filename: Name of the cache file to save.
        value: The value to cache.
        ttl: Time-to-live in seconds (default 1 hour).
    """
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w') as f:
            json.dump({'value': value, 'timestamp': time.time(), 'ttl': ttl}, f)
    except Exception as e:
        logger.warning(f"Failed to save cache file {filename}: {e}")

FINNHUB_TICKER_MAP = {
    ".ST": ".ST",
    ".SE": ".ST",
    ".TO": ".TO",
    ".L": ".L",
    ".PA": ".PA",
    ".DE": ".DE",
    ".AM": ".AS",
    ".BR": ".BR",
    ".MI": ".MI",
    ".AS": ".AS",
    ".SW": ".SW",
    ".AX": ".AX",
    ".NZ": ".NZ",
    ".HK": ".HK",
    ".T": ".T",
    ".KS": ".KS",
}

_CACHE_TTL_PROFILE = 86400
_CACHE_TTL_METRICS = 86400
_CACHE_TTL_PEERS = 86400
_CACHE_TTL_RECOMMENDATIONS = 3600

_CACHE_PROFILE: Dict[str, Tuple[Optional[Dict[str, Any]], float]] = {}
_CACHE_METRICS: Dict[str, Tuple[Optional[Dict[str, Any]], float]] = {}
_CACHE_PEERS: Dict[str, Tuple[Optional[List[str]], float]] = {}
_CACHE_RECOMMENDATIONS: Dict[str, Tuple[Optional[List[Dict[str, Any]]], float]] = {}


def get_finnhub_ticker(ticker: str) -> str:
    """Convert Yahoo Finance ticker to Finnhub format.
    
    Args:
        ticker: Yahoo Finance ticker symbol.
    
    Returns:
        str: Finnhub-compatible ticker symbol.
    """
    ticker_upper = ticker.upper()
    
    for yf_suffix, fh_suffix in FINNHUB_TICKER_MAP.items():
        if ticker_upper.endswith(yf_suffix):
            base = ticker_upper[:-len(yf_suffix)]
            return base + fh_suffix
    
    return ticker_upper


class FinnhubService:
    def __init__(self):
        """Initialize FinnhubService with API key from environment."""
        self.api_key = os.environ.get('FINNHUB_API_KEY')
        self.base_url = "https://finnhub.io/api/v1"
    
    def _make_request(self, endpoint: str, params: Optional[Dict[str, str]] = None) -> Optional[Any]:
        """
        Perform an authenticated GET to a Finnhub API endpoint and return the parsed JSON response.
        
        If the API key is missing, the HTTP status is not 200, or an error occurs during the request, returns `None`.
        
        Parameters:
            endpoint (str): Finnhub API path (for example, "stock/profile2").
            params (Optional[Dict[str, str]]): Query parameters to include in the request; the API token will be added automatically.
        
        Returns:
            Parsed JSON response data, or `None` if the request failed or returned a non-200 status.
        """
        if not self.api_key:
            return None
        
        params = params or {}
        params['token'] = self.api_key
        
        try:
            url = f"{self.base_url}/{endpoint}"
            started_at = time.perf_counter()
            response = requests.get(url, params=params, timeout=10)
            duration_ms = (time.perf_counter() - started_at) * 1000

            if duration_ms >= SLOW_FINNHUB_REQUEST_MS:
                logger.warning(
                    "Finnhub request slow endpoint=%s symbol=%s status=%s duration_ms=%.1f",
                    endpoint,
                    params.get('symbol'),
                    response.status_code,
                    duration_ms,
                )
            else:
                logger.info(
                    "Finnhub request endpoint=%s symbol=%s status=%s duration_ms=%.1f",
                    endpoint,
                    params.get('symbol'),
                    response.status_code,
                    duration_ms,
                )
            
            if response.status_code != 200:
                return None
            
            return response.json()
        except Exception:
            return None
    
    def get_company_profile(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Retrieve company profile from Finnhub.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Company profile with name, industry, country, etc.,
                or None if not found.
        """
        ticker_upper = ticker.upper()
        cache_file = f"finnhub_profile_{ticker_upper}.json"
        
        if ticker_upper in _CACHE_PROFILE:
            cached_data, timestamp = _CACHE_PROFILE[ticker_upper]
            if time.time() - timestamp < _CACHE_TTL_PROFILE:
                return cached_data
        
        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached
        
        finnhub_ticker = get_finnhub_ticker(ticker)
        data = self._make_request("stock/profile2", {"symbol": finnhub_ticker})
        
        if not data:
            _CACHE_PROFILE[ticker_upper] = (None, time.time())
            return None
        
        result = {
            'name': data.get('name'),
            'ticker': data.get('ticker'),
            'industry': data.get('finnhubIndustry'),
            'country': data.get('country'),
            'currency': data.get('currency'),
            'exchange': data.get('exchange'),
            'logo': data.get('logo'),
            'website': data.get('weburl'),
            'market_cap': data.get('marketCapitalization'),
            'shares_outstanding': data.get('shareOutstanding'),
            'ipo_date': data.get('ipo'),
            'phone': data.get('phone')
        }
        
        _CACHE_PROFILE[ticker_upper] = (result, time.time())
        _save_file_cache(cache_file, result, _CACHE_TTL_PROFILE)
        return result
    
    def get_basic_financials(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Retrieve financial metrics from Finnhub.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Financial metrics (P/E, margins, dividends, etc.),
                or None if not found.
        """
        ticker_upper = ticker.upper()
        cache_file = f"finnhub_metrics_{ticker_upper}.json"
        
        if ticker_upper in _CACHE_METRICS:
            cached_data, timestamp = _CACHE_METRICS[ticker_upper]
            if time.time() - timestamp < _CACHE_TTL_METRICS:
                return cached_data
        
        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached
        
        finnhub_ticker = get_finnhub_ticker(ticker)
        data = self._make_request("stock/metric", {"symbol": finnhub_ticker, "metric": "all"})
        
        if not data or 'metric' not in data:
            _CACHE_METRICS[ticker_upper] = (None, time.time())
            return None
        
        metrics = data['metric']
        
        result = {
            'pe_ttm': metrics.get('peBasicExclExtraTTM'),
            'pe_annual': metrics.get('peNormalizedAnnual'),
            'ps_ttm': metrics.get('psTTM'),
            'pb_annual': metrics.get('pbAnnual'),
            'dividend_yield': metrics.get('dividendYieldIndicatedAnnual'),
            'dividend_per_share_annual': metrics.get('dividendPerShareAnnual'),
            'dividend_per_share_ttm': metrics.get('dividendPerShareTTM'),
            'dividend_yield_ttm': metrics.get('dividendYieldTTM'),
            'dividend_growth_5y': metrics.get('dividendGrowthRate5Y'),
            'roe_ttm': metrics.get('roeTTM'),
            'roa_ttm': metrics.get('roaTTM'),
            'net_margin_ttm': metrics.get('netMarginTTM'),
            'gross_margin_ttm': metrics.get('grossMarginTTM'),
            'operating_margin_ttm': metrics.get('operatingMarginTTM'),
            'eps_ttm': metrics.get('epsBasicExclExtraItemsTTM'),
            'book_value_per_share': metrics.get('bookValuePerShareAnnual'),
            'cash_flow_per_share': metrics.get('cashFlowPerShareAnnual'),
            'revenue_growth_ttm': metrics.get('revenueGrowthTTM'),
            'revenue_growth_3y': metrics.get('revenueGrowth3Y'),
            'eps_growth_ttm': metrics.get('epsGrowthTTM'),
            'eps_growth_3y': metrics.get('epsGrowth3Y'),
            'beta': metrics.get('beta'),
            '52_week_high': metrics.get('52WeekHigh'),
            '52_week_low': metrics.get('52WeekLow'),
            '52_week_high_date': metrics.get('52WeekHighDate'),
            '52_week_low_date': metrics.get('52WeekLowDate'),
            'avg_volume_10d': metrics.get('10DayAverageTradingVolume'),
            'avg_volume_3m': metrics.get('3MonthAverageTradingVolume'),
        }
        
        _CACHE_METRICS[ticker_upper] = (result, time.time())
        _save_file_cache(cache_file, result, _CACHE_TTL_METRICS)
        return result
    
    def get_peers(self, ticker: str) -> Optional[List[str]]:
        """Retrieve peer companies from Finnhub.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            list: List of peer ticker symbols, or None if not found.
        """
        ticker_upper = ticker.upper()
        cache_file = f"finnhub_peers_{ticker_upper}.json"
        
        if ticker_upper in _CACHE_PEERS:
            cached_data, timestamp = _CACHE_PEERS[ticker_upper]
            if time.time() - timestamp < _CACHE_TTL_PEERS:
                return cached_data
        
        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached
        
        finnhub_ticker = get_finnhub_ticker(ticker)
        data = self._make_request("stock/peers", {"symbol": finnhub_ticker})
        
        if not data or not isinstance(data, list):
            _CACHE_PEERS[ticker_upper] = (None, time.time())
            return None
        
        result = [p for p in data if p != finnhub_ticker]
        _CACHE_PEERS[ticker_upper] = (result, time.time())
        _save_file_cache(cache_file, result, _CACHE_TTL_PEERS)
        return result
    
    def get_recommendation_trends(self, ticker: str) -> Optional[List[Dict[str, Any]]]:
        """Retrieve analyst recommendation trends from Finnhub.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            list: Recommendation trends with buy/sell/hold counts,
                or None if not found.
        """
        ticker_upper = ticker.upper()
        cache_file = f"finnhub_recs_{ticker_upper}.json"

        if ticker_upper in _CACHE_RECOMMENDATIONS:
            cached_data, timestamp = _CACHE_RECOMMENDATIONS[ticker_upper]
            if time.time() - timestamp < _CACHE_TTL_RECOMMENDATIONS:
                return cached_data

        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached
        
        finnhub_ticker = get_finnhub_ticker(ticker)
        data = self._make_request("stock/recommendation", {"symbol": finnhub_ticker})
        
        if not data or not isinstance(data, list):
            _CACHE_RECOMMENDATIONS[ticker_upper] = (None, time.time())
            return None
        
        result = []
        for item in data:
            result.append({
                'period': item.get('period'),
                'strong_buy': item.get('strongBuy', 0),
                'buy': item.get('buy', 0),
                'hold': item.get('hold', 0),
                'sell': item.get('sell', 0),
                'strong_sell': item.get('strongSell', 0),
                'total_analysts': (
                    item.get('strongBuy', 0) + 
                    item.get('buy', 0) + 
                    item.get('hold', 0) + 
                    item.get('sell', 0) + 
                    item.get('strongSell', 0)
                )
            })
        
        _CACHE_RECOMMENDATIONS[ticker_upper] = (result, time.time())
        _save_file_cache(cache_file, result, _CACHE_TTL_RECOMMENDATIONS)
        return result
    
    def clear_cache(self, ticker: Optional[str] = None):
        """Clear in-memory and file-based cache for a ticker or all tickers.
        
        Args:
            ticker: Specific ticker to clear, or None to clear all.
        """
        if ticker:
            ticker_upper = ticker.upper()
            _CACHE_PROFILE.pop(ticker_upper, None)
            _CACHE_METRICS.pop(ticker_upper, None)
            _CACHE_PEERS.pop(ticker_upper, None)
            _CACHE_RECOMMENDATIONS.pop(ticker_upper, None)
            
            cache_prefixes = [
                f"finnhub_profile_{ticker_upper}",
                f"finnhub_metrics_{ticker_upper}",
                f"finnhub_peers_{ticker_upper}",
                f"finnhub_recs_{ticker_upper}",
            ]
            for filename in os.listdir(CACHE_DIR):
                for prefix in cache_prefixes:
                    if filename.startswith(prefix):
                        filepath = os.path.join(CACHE_DIR, filename)
                        try:
                            os.remove(filepath)
                        except OSError as e:
                            logger.warning(f"Failed to delete cache file {filepath}: {e}")
                        break
        else:
            _CACHE_PROFILE.clear()
            _CACHE_METRICS.clear()
            _CACHE_PEERS.clear()
            _CACHE_RECOMMENDATIONS.clear()
            
            for filename in os.listdir(CACHE_DIR):
                if filename.startswith('finnhub_'):
                    filepath = os.path.join(CACHE_DIR, filename)
                    try:
                        os.remove(filepath)
                    except OSError as e:
                        logger.warning(f"Failed to delete cache file {filepath}: {e}")


finnhub_service = FinnhubService()
