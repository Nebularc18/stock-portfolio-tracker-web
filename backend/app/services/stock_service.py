import requests
import json
import importlib
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import logging

from app.services.finnhub_service import finnhub_service
from app.services.avanza_service import avanza_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
        if datetime.now().timestamp() - data.get('timestamp', 0) < data.get('ttl', 3600):
            return data.get('value')
        return None
    except Exception:
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
            json.dump({'value': value, 'timestamp': datetime.now().timestamp(), 'ttl': ttl}, f)
    except Exception as e:
        logger.warning(f"Failed to save cache {filename}: {e}")

CURRENCY_MAP = {
    ".ST": "SEK", ".SE": "SEK", ".CO": "DKK", ".HE": "EUR",
    ".OL": "NOK", ".IC": "ISK", ".TO": "CAD", ".L": "GBP",
    ".PA": "EUR", ".DE": "EUR", ".AM": "EUR", ".BR": "EUR",
    ".MI": "EUR", ".AS": "EUR", ".SW": "CHF", ".AX": "AUD",
    ".NZ": "NZD", ".HK": "HKD", ".T": "JPY", ".KS": "KRW",
}

_TICKER_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300

_DIVIDEND_CACHE: Dict[str, tuple] = {}
_DIVIDEND_CACHE_TTL = 86400 * 30

_sector_cache: Dict[str, Optional[str]] = {}

_ANALYST_SINGLE_CACHE: Dict[str, tuple] = {}
_ANALYST_ALL_CACHE: Dict[str, tuple] = {}
_ANALYST_CACHE_TTL = 43200
_ANALYST_NEGATIVE_CACHE_TTL = 300

_PRICE_TARGETS_CACHE: Dict[str, tuple] = {}
_PRICE_TARGETS_CACHE_TTL = 43200
_PRICE_TARGETS_FALLBACK_CACHE_TTL = 300
_YAHOO_ANALYST_PAGE_CACHE: Dict[str, tuple] = {}
_YAHOO_ANALYST_PAGE_CACHE_TTL = 3600
_ANALYST_SINGLE_CACHE_KIND = "single_analyst_recommendations"
_ANALYST_ALL_CACHE_KIND = "all_analyst_recommendations"
_PRICE_TARGETS_CACHE_KIND = "price_targets"

_session = None


def _is_marked_cache_payload(value: Any, cache_kind: str) -> bool:
    return (
        isinstance(value, dict)
        and value.get('cache_status') == 'hit'
        and value.get('cache_kind') == cache_kind
    )


def _wrap_single_analyst_cache_value(value: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    return {
        'cache_status': 'hit',
        'cache_kind': _ANALYST_SINGLE_CACHE_KIND,
        'has_recommendations': value is not None,
        'value': value,
    }


def _unwrap_single_analyst_cache_value(value: Any) -> Optional[List[Dict[str, Any]]]:
    if _is_marked_cache_payload(value, _ANALYST_SINGLE_CACHE_KIND):
        return value.get('value')
    return value


def _wrap_all_analyst_cache_value(
    yfinance_recs: Optional[List[Dict[str, Any]]],
    finnhub_recs: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    return {
        'cache_status': 'hit',
        'cache_kind': _ANALYST_ALL_CACHE_KIND,
        'has_recommendations': bool(yfinance_recs or finnhub_recs),
        'yfinance': yfinance_recs,
        'finnhub': finnhub_recs,
    }


def _unwrap_all_analyst_cache_value(value: Any) -> Dict[str, Optional[List[Dict[str, Any]]]]:
    if _is_marked_cache_payload(value, _ANALYST_ALL_CACHE_KIND):
        return {
            'yfinance': value.get('yfinance'),
            'finnhub': value.get('finnhub'),
        }
    return value


def _has_any_analyst_recommendations(value: Any) -> bool:
    value = _unwrap_all_analyst_cache_value(value)
    if not isinstance(value, dict):
        return False
    return bool(value.get('yfinance') or value.get('finnhub'))


def _is_fallback_price_targets(value: Any) -> bool:
    if _is_marked_cache_payload(value, _PRICE_TARGETS_CACHE_KIND):
        value = value.get('value')
    return isinstance(value, dict) and bool(value.get('note'))


def _wrap_price_targets_cache_value(value: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        'cache_status': 'hit',
        'cache_kind': _PRICE_TARGETS_CACHE_KIND,
        'has_price_targets': value is not None,
        'value': value,
    }


def _unwrap_price_targets_cache_value(value: Any) -> Optional[Dict[str, Any]]:
    if _is_marked_cache_payload(value, _PRICE_TARGETS_CACHE_KIND):
        return value.get('value')
    return value


def _get_single_analyst_cache_ttl(value: Any) -> int:
    value = _unwrap_single_analyst_cache_value(value)
    return _ANALYST_CACHE_TTL if value else _ANALYST_NEGATIVE_CACHE_TTL


def _get_all_analyst_cache_ttl(value: Any) -> int:
    return _ANALYST_CACHE_TTL if _has_any_analyst_recommendations(value) else _ANALYST_NEGATIVE_CACHE_TTL


def _get_price_targets_cache_ttl(value: Any) -> int:
    value = _unwrap_price_targets_cache_value(value)
    return _PRICE_TARGETS_CACHE_TTL if (value and not _is_fallback_price_targets(value)) else _PRICE_TARGETS_FALLBACK_CACHE_TTL


def _extract_raw_finance_value(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get('raw')
    return value


def _import_yfinance_with_csrf_strategy():
    yf = importlib.import_module('yfinance')
    try:
        from yfinance.data import YfData

        # In some environments fc.yahoo.com resolves to 0.0.0.0, which breaks
        # yfinance's default basic cookie bootstrap before it can fall back.
        YfData()._set_cookie_strategy('csrf')
    except Exception as exc:
        logger.debug("Unable to force yfinance csrf cookie strategy: %s", exc)
    return yf

def get_session():
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
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
        })
    return _session


def detect_currency(ticker: str) -> str:
    """Detect currency based on ticker exchange suffix.
    
    Args:
        ticker: Stock ticker symbol with optional exchange suffix.
    
    Returns:
        str: Currency code (e.g., 'SEK', 'USD', 'EUR').
    """
    ticker_upper = ticker.upper()
    for suffix, currency in CURRENCY_MAP.items():
        if ticker_upper.endswith(suffix):
            return currency
    return "USD"


def fetch_yahoo_quote(ticker: str) -> Optional[Dict]:
    """Fetch current quote data from Yahoo Finance.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        dict: Quote data with current_price, previous_close, currency,
            name, sector, and other fields, or None if fetch fails.
    """
    ticker = ticker.upper()
    cache_file = f"quote_{ticker}.json"
    
    cached = _load_file_cache(cache_file)
    if cached is not None:
        return cached
    
    if ticker in _TICKER_CACHE:
        data, timestamp = _TICKER_CACHE[ticker]
        if datetime.now().timestamp() - timestamp < _CACHE_TTL:
            return data
    
    session = get_session()
    
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        response = session.get(url, timeout=10)
        
        if response.status_code == 429:
            logger.warning(f"Rate limited by Yahoo Finance for {ticker}")
            return None
        
        if response.status_code != 200:
            logger.error(f"Yahoo Finance returned {response.status_code} for {ticker}")
            return None
        
        data = response.json()
        
        if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
            logger.error(f"No chart data for {ticker}")
            return None
        
        result = data['chart']['result'][0]
        meta = result.get('meta', {})
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        
        closes = quote.get('close', [])
        prices = [p for p in closes if p is not None]
        
        if not prices:
            logger.error(f"No price data for {ticker}")
            return None
        
        current_price = prices[-1]
        previous_close = prices[-2] if len(prices) > 1 else current_price
        
        currency = meta.get('currency', detect_currency(ticker))
        
        result_data = {
            'ticker': ticker,
            'current_price': current_price,
            'previous_close': previous_close,
            'currency': currency,
            'name': meta.get('shortName') or meta.get('longName') or ticker,
            'sector': None,
            'dividend_yield': None,
            'dividend_per_share': None,
            'fifty_two_week_high': meta.get('fiftyTwoWeekHigh'),
            'fifty_two_week_low': meta.get('fiftyTwoWeekLow'),
            'market_cap': meta.get('marketCap'),
        }
        
        _TICKER_CACHE[ticker] = (result_data, datetime.now().timestamp())
        _save_file_cache(cache_file, result_data, _CACHE_TTL)
        
        return result_data
        
    except Exception as e:
        logger.error(f"Error fetching {ticker} from Yahoo: {e}")
        return None


def fetch_yahoo_sector(ticker: str) -> Optional[str]:
    """Fetch sector information from Yahoo Finance search API.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        str: Sector name, or None if not found.
    """
    ticker = ticker.upper()
    cache_file = f"sector_{ticker}.json"
    
    cached = _load_file_cache(cache_file)
    if cached is not None:
        return cached
    
    if ticker in _sector_cache:
        return _sector_cache[ticker]
    
    session = get_session()
    
    try:
        url = f"https://query1.finance.yahoo.com/v1/finance/search?q={ticker}"
        response = session.get(url, timeout=10)
        
        if response.status_code != 200:
            return None
        
        data = response.json()
        
        sector = None
        if 'quotes' in data and data['quotes']:
            for quote in data['quotes']:
                if quote.get('symbol', '').upper() == ticker:
                    sector = quote.get('sector')
                    break
            if sector is None:
                sector = data['quotes'][0].get('sector')
        
        if sector:
            _sector_cache[ticker] = sector
            _save_file_cache(cache_file, sector, 86400)
        
        return sector
        
    except Exception as e:
        logger.error(f"Error fetching sector for {ticker}: {e}")
        return None


def fetch_yahoo_info(ticker: str) -> Optional[Dict]:
    """Fetch additional stock info including sector and dividend data.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        dict: Info with sector, dividend_yield, and dividend_per_share.
    """
    ticker = ticker.upper()
    
    sector = fetch_yahoo_sector(ticker)
    
    return {
        'ticker': ticker,
        'sector': sector,
        'dividend_yield': None,
        'dividend_per_share': None,
    }


class StockService:
    def __init__(self):
        """Initialize StockService with default cache TTL."""
        self.cache_ttl = 300

    def fetch_ticker_data(self, ticker: str) -> Optional[Dict]:
        """Fetch comprehensive data for a ticker from Yahoo Finance.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Combined data from quote and info endpoints,
                or None if fetch fails.
        """
        ticker = ticker.upper()
        logger.info(f"Fetching data for {ticker}")
        
        data = fetch_yahoo_quote(ticker)
        
        if data:
            extra_info = fetch_yahoo_info(ticker)
            if extra_info:
                data['sector'] = extra_info.get('sector') or data.get('sector')
                data['dividend_yield'] = extra_info.get('dividend_yield')
                data['dividend_per_share'] = extra_info.get('dividend_per_share')
                if extra_info.get('name') and extra_info['name'] != ticker:
                    data['name'] = extra_info['name']
            
            return data
        
        data = fetch_yahoo_info(ticker)
        if data:
            return data
        
        return None

    def validate_ticker(self, ticker: str) -> bool:
        """Validate that a ticker exists and has price data.
        
        Args:
            ticker: Stock ticker symbol to validate.
        
        Returns:
            bool: True if ticker is valid with price data.
        """
        data = self.fetch_ticker_data(ticker)
        return data is not None and data.get('current_price') is not None

    def get_stock_info(self, ticker: str) -> Optional[dict]:
        """Retrieve stock information for a ticker.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Stock data or None if not found.
        """
        return self.fetch_ticker_data(ticker)

    def get_stock_price(self, ticker: str) -> Optional[float]:
        """Retrieve current stock price.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            float: Current price, or None if not available.
        """
        data = self.fetch_ticker_data(ticker)
        return data.get('current_price') if data else None

    def get_previous_close(self, ticker: str) -> Optional[float]:
        """Retrieve previous day's closing price.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            float: Previous close price, or None if not available.
        """
        data = self.fetch_ticker_data(ticker)
        return data.get('previous_close') if data else None

    def get_multiple_prices(self, tickers: list) -> dict:
        """Retrieve current prices for multiple tickers.
        
        Args:
            tickers: List of stock ticker symbols.
        
        Returns:
            dict: Mapping of uppercase tickers to current prices.
        """
        results = {}
        for ticker in tickers:
            data = self.fetch_ticker_data(ticker)
            results[ticker.upper()] = data.get('current_price') if data else None
        return results

    def get_sector(self, ticker: str, stock=None) -> Optional[str]:
        """Retrieve sector for a stock.
        
        Args:
            ticker: Stock ticker symbol.
            stock: Optional stock object (unused, kept for compatibility).
        
        Returns:
            str: Sector name, or None if not available.
        """
        data = self.fetch_ticker_data(ticker)
        return data.get('sector') if data else None

    def get_dividends(self, ticker: str, years: int = 5) -> list:
        """
        Retrieve recent dividend history for a stock.
        
        Parameters:
            ticker (str): Stock ticker symbol (case-insensitive). If an Avanza mapping with a valid instrument_id exists, Avanza data is used and takes precedence over Yahoo.
            years (int): Number of years of history to retrieve (default 5).
        
        Returns:
            list: List of dividend records sorted newest first. Each record is a dict with keys:
                - date (str): Ex-dividend date in "YYYY-MM-DD" format.
                - amount (float): Dividend amount per share.
                - currency (str|None): Currency code when known, otherwise `None`.
                - source (str): Origin of the data, e.g., "avanza" or "yahoo".
                - payment_date (str|None): Payment date in "YYYY-MM-DD" format when available (otherwise `None`).
                - dividend_type (str|None): Dividend type when available (otherwise `None`).
        """
        ticker = ticker.upper()
        
        # Check if there's an Avanza mapping for this ticker - takes precedence
        try:
            avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
            if avanza_mapping:
                if avanza_mapping.instrument_id:
                    logger.debug(f"get_dividends: Found Avanza mapping for {ticker}, fetching historical dividends")
                    avanza_divs = avanza_service.get_historical_dividends(ticker, years)
                    if avanza_divs:
                        logger.debug(f"get_dividends: Returning {len(avanza_divs)} Avanza dividends for {ticker}")
                        normalized_avanza_divs = []
                        for item in avanza_divs:
                            normalized_avanza_divs.append({
                                'date': item.get('date'),
                                'amount': item.get('amount'),
                                'currency': item.get('currency'),
                                'source': 'avanza',
                                'payment_date': item.get('payment_date'),
                                'dividend_type': item.get('dividend_type'),
                            })
                        normalized_avanza_divs.sort(key=lambda x: x.get('date') or '', reverse=True)
                        return normalized_avanza_divs

                    logger.debug(f"get_dividends: Avanza returned no dividends for {ticker}, falling back to Yahoo")
                else:
                    logger.debug(f"get_dividends: Avanza mapping for {ticker} has no instrument_id, falling back to Yahoo")
            else:
                logger.debug(f"get_dividends: No Avanza mapping for {ticker}, using Yahoo Finance")
        except Exception as exc:
            logger.warning(f"get_dividends: Avanza provider failed for {ticker}, falling back to Yahoo: {exc}")
        
        cache_key = f"{ticker}_{years}"
        cache_file = f"dividends_{cache_key}.json"
        
        cached = _load_file_cache(cache_file)
        if cached is not None:
            logger.debug(f"get_dividends: Returning cached dividends for {ticker}")
            return cached
        
        if cache_key in _DIVIDEND_CACHE:
            cached_data, timestamp = _DIVIDEND_CACHE[cache_key]
            if datetime.now().timestamp() - timestamp < _DIVIDEND_CACHE_TTL:
                logger.debug(f"get_dividends: Returning memory-cached dividends for {ticker}")
                return cached_data
        
        session = get_session()
        
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range={years}y&events=div"
            logger.debug(f"get_dividends: Fetching dividends from Yahoo for {ticker}")
            response = session.get(url, timeout=15)
            
            if response.status_code != 200:
                logger.warning(f"get_dividends: Yahoo returned {response.status_code} for {ticker}")
                return []
            
            data = response.json()
            
            if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
                logger.debug(f"get_dividends: No chart result in Yahoo response for {ticker}")
                return []
            
            result = data['chart']['result'][0]
            events = result.get('events', {})
            dividends = events.get('dividends', {})
            
            if not dividends:
                logger.debug(f"get_dividends: No dividend events found for {ticker}")
                return []
            
            result_list = []
            for ts, div_data in dividends.items():
                result_list.append({
                    'date': datetime.fromtimestamp(div_data['date'], tz=timezone.utc).strftime('%Y-%m-%d'),
                    'amount': div_data['amount'],
                    'currency': None,
                    'payment_date': None,
                    'dividend_type': None,
                    'source': 'yahoo'
                })
            
            result_list.sort(key=lambda x: x['date'], reverse=True)
            
            logger.debug(f"get_dividends: Found {len(result_list)} Yahoo dividends for {ticker}")
            
            _DIVIDEND_CACHE[cache_key] = (result_list, datetime.now().timestamp())
            _save_file_cache(cache_file, result_list, _DIVIDEND_CACHE_TTL)
            return result_list
            
        except Exception as e:
            logger.error(f"Error fetching dividends for {ticker}: {e}")
            return []

    def get_upcoming_dividends(self, ticker: str) -> Optional[List[Dict[str, Any]]]:
        """
        Retrieve upcoming dividend events for a stock.
        
        Avanza is used as the primary data source for any ticker that has an Avanza mapping
        (instrument_id). If Avanza returns events, those are returned directly. If no Avanza
        events are found, the function falls back to yfinance (same behavior as unmapped tickers).
        
        Parameters:
            ticker (str): Stock ticker symbol (case is ignored).
        
        Returns:
            List[Dict[str, Any]]: A list of upcoming dividend event objects (empty list if none). Each event contains:
                - 'ex_date' (str): Ex-dividend date in 'YYYY-MM-DD' format.
                - 'amount' (float|None): Dividend amount if available.
                - 'currency' (str|None): Currency code if available.
                - 'payment_date' (str|None): Payment date in 'YYYY-MM-DD' format (present for Avanza-sourced events).
                - 'dividend_type' (str|None): Dividend type identifier (e.g. 'ordinary', 'bonus').
                - 'source' (str): Data source identifier, e.g. 'avanza' or 'yahoo'.
        """
        ticker = ticker.upper()
        
        # Check if there's an Avanza mapping for this ticker - takes precedence
        try:
            avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
            if avanza_mapping and avanza_mapping.instrument_id:
                avanza_dividends = avanza_service.get_stock_dividends(ticker)
                if avanza_dividends:
                    logger.debug(f"Found {len(avanza_dividends)} Avanza upcoming dividends for {ticker}")
                    return [{
                        'ex_date': div.ex_date,
                        'amount': div.amount,
                        'currency': div.currency,
                        'payment_date': div.payment_date,
                        'dividend_type': div.dividend_type,
                        'source': 'avanza'
                    } for div in avanza_dividends]

                logger.debug(
                    f"Avanza mapping found for {ticker} but no upcoming dividends returned; "
                    f"continuing with yfinance fallback"
                )
        except Exception as exc:
            logger.warning(f"get_upcoming_dividends: Avanza provider failed for {ticker}, falling back to Yahoo: {exc}")

        if ticker.endswith('.ST'):
            logger.debug(f"Swedish ticker {ticker} has no Avanza mapping or instrument_id, falling back to yfinance")
        
        try:
            yf = _import_yfinance_with_csrf_strategy()
            yf_ticker = yf.Ticker(ticker)

            def _to_date_str(value: Any) -> Optional[str]:
                """
                Normalize various date-like inputs to an ISO date string (YYYY-MM-DD) or return None.
                
                Parameters:
                    value (Any): A date-like input which may be a datetime/date object, a pandas Timestamp (or similar with `to_pydatetime`),
                                 a list/sequence whose first element is a date-like value, an integer/float epoch timestamp (seconds),
                                 or a string representation of a date.
                
                Returns:
                    Optional[str]: An ISO-formatted date string `YYYY-MM-DD` if the input can be interpreted as a date, `None` otherwise.
                """
                if value is None:
                    return None

                if isinstance(value, list):
                    if not value:
                        return None
                    value = value[0]

                if hasattr(value, 'to_pydatetime'):
                    try:
                        value = value.to_pydatetime()
                    except (ValueError, TypeError):
                        return None

                if hasattr(value, 'strftime'):
                    try:
                        return value.strftime('%Y-%m-%d')
                    except (ValueError, TypeError):
                        return None

                if isinstance(value, (int, float)):
                    try:
                        return datetime.fromtimestamp(value, tz=timezone.utc).strftime('%Y-%m-%d')
                    except (OSError, OverflowError, ValueError) as exc:
                        logger.debug(f"get_upcoming_dividends: failed to parse timestamp for {ticker}: {exc}")
                        return None

                value_str = str(value)
                return value_str[:10] if len(value_str) >= 10 else None
            
            # Try to get dividend info from yfinance
            info = getattr(yf_ticker, 'info', {}) or {}
            
            # Method 1: Try calendar attribute (newer yfinance versions)
            calendar = getattr(yf_ticker, 'calendar', None)
            
            if calendar is not None and isinstance(calendar, dict):
                calendar_ex_date = (
                    calendar.get('Ex-Dividend Date')
                    or calendar.get('Ex Dividend Date')
                    or info.get('exDividendDate')
                )
                calendar_payment_date = calendar.get('Dividend Date') or info.get('dividendDate')
                ex_date_str = _to_date_str(calendar_ex_date)
                payment_date_str = _to_date_str(calendar_payment_date)

                div_rate = info.get('dividendRate') or info.get('forwardDividendRate')

                if ex_date_str and div_rate:
                    logger.debug(
                        f"Found yfinance calendar dividend for {ticker}: "
                        f"ex_date={ex_date_str}, payment_date={payment_date_str}, amount={div_rate}"
                    )
                    return [{
                        'ex_date': ex_date_str,
                        'amount': div_rate,
                        'currency': info.get('currency'),
                        'payment_date': payment_date_str,
                        'dividend_type': None,
                        'source': 'yahoo'
                    }]
            
            # Method 2: Fallback to info dict for ex-dividend date and dividend rate
            ex_dividend_timestamp = info.get('exDividendDate')
            payment_timestamp = info.get('dividendDate')
            div_rate = info.get('dividendRate')
            forward_div_rate = info.get('forwardDividendRate')
            
            # Use forward dividend rate if dividend rate is not available
            effective_div_rate = div_rate or forward_div_rate
            
            if ex_dividend_timestamp and effective_div_rate:
                ex_date = _to_date_str(ex_dividend_timestamp)
                payment_date = _to_date_str(payment_timestamp)
                if ex_date:
                    logger.debug(
                        f"Found yfinance info dividend for {ticker}: "
                        f"ex_date={ex_date}, payment_date={payment_date}, amount={effective_div_rate}"
                    )
                    return [{
                        'ex_date': ex_date,
                        'amount': effective_div_rate,
                        'currency': info.get('currency'),
                        'payment_date': payment_date,
                        'dividend_type': None,
                        'source': 'yahoo'
                    }]
            
            # Method 3: Try dividends attribute for recent dividend data
            dividends_attr = getattr(yf_ticker, 'dividends', None)
            if dividends_attr is not None and len(dividends_attr) > 0:
                # Get the most recent dividend
                try:
                    last_div = dividends_attr.iloc[-1]
                    last_div_date = dividends_attr.index[-1]
                    
                    now = datetime.now(tz=timezone.utc)
                    recent_date = now - timedelta(days=90)
                    
                    if hasattr(last_div_date, 'to_pydatetime'):
                        div_datetime = last_div_date.to_pydatetime()
                    else:
                        div_datetime = last_div_date
                    
                    # Convert to timezone-aware if needed
                    if div_datetime.tzinfo is None:
                        div_datetime = div_datetime.replace(tzinfo=timezone.utc)
                    
                    if recent_date <= div_datetime <= now:
                        logger.debug(
                            f"Ignoring recent historical dividend for {ticker}: "
                            f"ex_date={div_datetime.strftime('%Y-%m-%d')}"
                        )
                    elif div_datetime > now:
                        ex_date_str = div_datetime.strftime('%Y-%m-%d')
                        logger.debug(f"Found yfinance dividends attribute for {ticker}: ex_date={ex_date_str}, amount={float(last_div)}")
                        return [{
                            'ex_date': ex_date_str,
                            'amount': float(last_div),
                            'currency': info.get('currency'),
                            'payment_date': _to_date_str(info.get('dividendDate')),
                            'dividend_type': None,
                            'source': 'yahoo'
                        }]
                except (AttributeError, TypeError, ValueError, IndexError) as div_err:
                    logger.debug(f"Error parsing dividends attribute for {ticker}: {div_err}")
            
            logger.debug(f"No upcoming dividend found for {ticker} via yfinance")
            return []
            
        except Exception as e:
            logger.error(f"Error fetching upcoming dividends for {ticker}: {e}")
            return []

    def get_quote_extended(self, ticker: str) -> Optional[Dict[str, Any]]:
        """
        Fetches the 52-week high/low and currency for a given stock ticker from Yahoo Finance.
        
        Parameters:
        	ticker (str): Stock ticker symbol (case-insensitive).
        
        Returns:
        	dict or None: A dictionary with keys 'fifty_two_week_high' (number or None), 'fifty_two_week_low' (number or None), and 'currency' (string or None); returns None if the data cannot be retrieved.
        """
        ticker = ticker.upper()
        session = get_session()
        
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1y"
            response = session.get(url, timeout=10)
            
            if response.status_code != 200:
                return None
            
            data = response.json()
            
            if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
                return None
            
            result = data['chart']['result'][0]
            meta = result.get('meta', {})
            
            return {
                'fifty_two_week_high': meta.get('fiftyTwoWeekHigh'),
                'fifty_two_week_low': meta.get('fiftyTwoWeekLow'),
                'currency': meta.get('currency'),
            }
            
        except Exception as e:
            logger.error(f"Error fetching extended quote for {ticker}: {e}")
            return None

    def get_analyst_recommendations(self, ticker: str) -> Optional[List[Dict[str, Any]]]:
        """Retrieve analyst recommendations for a stock.
        
        Tries yfinance first, falls back to Finnhub.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            list: Recommendation trends with buy/sell/hold counts,
                or None if unavailable.
        """
        ticker_upper = ticker.upper()
        cache_file = f"analyst_recs_{ticker_upper}.json"

        cached = _load_file_cache(cache_file)
        if _is_marked_cache_payload(cached, _ANALYST_SINGLE_CACHE_KIND):
            return _unwrap_single_analyst_cache_value(cached)
        if cached is not None:
            return cached

        if ticker_upper in _ANALYST_SINGLE_CACHE:
            data, timestamp = _ANALYST_SINGLE_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _get_single_analyst_cache_ttl(data):
                return _unwrap_single_analyst_cache_value(data)

        normalized = self._get_yfinance_recommendations(ticker_upper)
        
        if not normalized:
            normalized = self._get_finnhub_recommendations(ticker_upper)

        if normalized:
            _ANALYST_SINGLE_CACHE[ticker_upper] = (normalized, datetime.now().timestamp())
            _save_file_cache(cache_file, normalized, _ANALYST_CACHE_TTL)
            return normalized

        negative_payload = _wrap_single_analyst_cache_value(None)
        _ANALYST_SINGLE_CACHE[ticker_upper] = (negative_payload, datetime.now().timestamp())
        _save_file_cache(cache_file, negative_payload, _ANALYST_NEGATIVE_CACHE_TTL)
        return None

    def get_all_analyst_recommendations(self, ticker: str) -> Dict[str, Optional[List[Dict[str, Any]]]]:
        """Retrieve analyst recommendations from all sources.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Contains 'yfinance' and 'finnhub' recommendation lists.
        """
        ticker_upper = ticker.upper()
        cache_file = f"all_analyst_recs_{ticker_upper}.json"
        
        cached = _load_file_cache(cache_file)
        if _is_marked_cache_payload(cached, _ANALYST_ALL_CACHE_KIND):
            return _unwrap_all_analyst_cache_value(cached)
        if _has_any_analyst_recommendations(cached):
            return _unwrap_all_analyst_cache_value(cached)
        
        if ticker_upper in _ANALYST_ALL_CACHE:
            data, timestamp = _ANALYST_ALL_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _get_all_analyst_cache_ttl(data):
                return _unwrap_all_analyst_cache_value(data)
        
        yfinance_recs = self._get_yfinance_recommendations(ticker_upper)
        finnhub_recs = self._get_finnhub_recommendations(ticker_upper)
        
        result = _wrap_all_analyst_cache_value(yfinance_recs, finnhub_recs)
        cache_ttl = _get_all_analyst_cache_ttl(result)
        _ANALYST_ALL_CACHE[ticker_upper] = (result, datetime.now().timestamp())
        _save_file_cache(cache_file, result, cache_ttl)

        return _unwrap_all_analyst_cache_value(result)

    def _get_yfinance_recommendations(self, ticker_upper: str) -> Optional[List[Dict[str, Any]]]:
        """Fetch analyst recommendations from yfinance library.
        
        Args:
            ticker_upper: Uppercase stock ticker symbol.
        
        Returns:
            list: Normalized recommendations with period and counts,
                or None if unavailable.
        """
        logger.info(f"[YFINANCE] Attempting to fetch recommendations for {ticker_upper}")
        try:
            yf = _import_yfinance_with_csrf_strategy()
            yf_ticker = yf.Ticker(ticker_upper)
            
            logger.info(f"[YFINANCE] Calling recommendations attribute for {ticker_upper}")
            recs_df = getattr(yf_ticker, 'recommendations', None)
            if recs_df is None or (hasattr(recs_df, 'empty') and recs_df.empty):
                logger.info(f"[YFINANCE] recommendations empty, trying recommendations_summary for {ticker_upper}")
                recs_df = getattr(yf_ticker, 'recommendations_summary', None)

            if recs_df is None or (hasattr(recs_df, 'empty') and recs_df.empty):
                logger.warning(f"[YFINANCE] No recommendations data returned for {ticker_upper}")
                quote_page_recs = self._get_quote_page_recommendations(ticker_upper)
                if quote_page_recs:
                    logger.info(f"[YAHOO PAGE] Using quote page recommendations fallback for {ticker_upper}")
                    return quote_page_recs
                return None
            
            logger.info(f"[YFINANCE] Successfully got recommendations for {ticker_upper}")

            records: List[Dict[str, Any]] = []

            if hasattr(recs_df, 'reset_index'):
                try:
                    records = recs_df.reset_index().to_dict(orient='records')
                except Exception:
                    records = []
            elif isinstance(recs_df, list):
                records = recs_df
            elif isinstance(recs_df, dict):
                records = recs_df.get('trend', [])

            normalized: List[Dict[str, Any]] = []
            for item in records:
                if not isinstance(item, dict):
                    continue

                period = item.get('period') or item.get('index') or item.get('Date') or item.get('date')
                if not period:
                    continue

                strong_buy = int(item.get('strongBuy', item.get('strong_buy', 0)) or 0)
                buy = int(item.get('buy', 0) or 0)
                hold = int(item.get('hold', 0) or 0)
                sell = int(item.get('sell', 0) or 0)
                strong_sell = int(item.get('strongSell', item.get('strong_sell', 0)) or 0)

                normalized.append({
                    'period': str(period),
                    'strong_buy': strong_buy,
                    'buy': buy,
                    'hold': hold,
                    'sell': sell,
                    'strong_sell': strong_sell,
                    'total_analysts': strong_buy + buy + hold + sell + strong_sell,
                })

            if normalized:
                return normalized

            quote_page_recs = self._get_quote_page_recommendations(ticker_upper)
            if quote_page_recs:
                logger.info(f"[YAHOO PAGE] Using quote page recommendations fallback for {ticker_upper}")
                return quote_page_recs

            return None

        except Exception as e:
            logger.warning(f"yfinance recommendations failed for {ticker_upper}: {e}")
            quote_page_recs = self._get_quote_page_recommendations(ticker_upper)
            if quote_page_recs:
                logger.info(f"[YAHOO PAGE] Using quote page recommendations fallback for {ticker_upper}")
                return quote_page_recs
            return None

    def _get_finnhub_recommendations(self, ticker_upper: str) -> Optional[List[Dict[str, Any]]]:
        """Fetch analyst recommendations from Finnhub API.
        
        Args:
            ticker_upper: Uppercase stock ticker symbol.
        
        Returns:
            list: Normalized recommendations with period and counts,
                or None if unavailable.
        """
        try:
            finnhub_recs = finnhub_service.get_recommendation_trends(ticker_upper)
            if not finnhub_recs:
                return None
            
            normalized: List[Dict[str, Any]] = []
            for item in finnhub_recs:
                normalized.append({
                    'period': item.get('period', ''),
                    'strong_buy': item.get('strong_buy', 0),
                    'buy': item.get('buy', 0),
                    'hold': item.get('hold', 0),
                    'sell': item.get('sell', 0),
                    'strong_sell': item.get('strong_sell', 0),
                    'total_analysts': item.get('total_analysts', 0),
                })
            
            return normalized if normalized else None

        except Exception as e:
            logger.warning(f"Finnhub recommendations failed for {ticker_upper}: {e}")
            return None

    def _get_yahoo_analyst_quote_summary(self, ticker_upper: str) -> Optional[Dict[str, Any]]:
        if ticker_upper in _YAHOO_ANALYST_PAGE_CACHE:
            data, timestamp = _YAHOO_ANALYST_PAGE_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _YAHOO_ANALYST_PAGE_CACHE_TTL:
                return data

        session = get_session()
        try:
            response = session.get(
                f"https://finance.yahoo.com/quote/{ticker_upper}?p={ticker_upper}",
                timeout=15,
            )
            if response.status_code != 200:
                logger.warning("Yahoo analyst quote page returned %s for %s", response.status_code, ticker_upper)
                return None

            # Last verified: 2026-03-17 against Yahoo's analyst quote page HTML.
            # This regex-based quoteSummary extraction is intentionally a fragile
            # fallback for when yfinance fails. If Yahoo changes the HTML script
            # attributes or payload shape, check both `pattern` and the
            # follow-up `json.loads(body)` parsing here and update or remove the
            # fallback accordingly.
            pattern = re.compile(
                rf'<script type="application/json" data-sveltekit-fetched data-url="https://query1\.finance\.yahoo\.com/v10/finance/quoteSummary/{re.escape(ticker_upper)}\?[^"]*modules=[^"]*financialData%2CrecommendationTrend[^"]*" data-ttl="1">(.*?)</script>',
                re.DOTALL,
            )
            match = pattern.search(response.text)
            if not match:
                logger.warning("Yahoo analyst quote page did not contain quoteSummary payload for %s", ticker_upper)
                return None

            outer_payload = json.loads(match.group(1))
            body = outer_payload.get('body')
            if not isinstance(body, str):
                return None

            quote_summary = json.loads(body).get('quoteSummary', {}).get('result', [])
            if not quote_summary:
                return None

            result = quote_summary[0]
            _YAHOO_ANALYST_PAGE_CACHE[ticker_upper] = (result, datetime.now().timestamp())
            return result
        except Exception as exc:
            logger.warning("Yahoo analyst quote page fallback failed for %s: %s", ticker_upper, exc)
            return None

    def _get_quote_page_recommendations(self, ticker_upper: str) -> Optional[List[Dict[str, Any]]]:
        quote_summary = self._get_yahoo_analyst_quote_summary(ticker_upper)
        if not quote_summary:
            return None

        recommendation_trend = quote_summary.get('recommendationTrend', {})
        trend = recommendation_trend.get('trend') if isinstance(recommendation_trend, dict) else None
        if not isinstance(trend, list) or not trend:
            return None

        normalized: List[Dict[str, Any]] = []
        for item in trend:
            if not isinstance(item, dict):
                continue

            period = item.get('period')
            if not period:
                continue

            strong_buy = int(item.get('strongBuy', item.get('strong_buy', 0)) or 0)
            buy = int(item.get('buy', 0) or 0)
            hold = int(item.get('hold', 0) or 0)
            sell = int(item.get('sell', 0) or 0)
            strong_sell = int(item.get('strongSell', item.get('strong_sell', 0)) or 0)

            normalized.append({
                'period': str(period),
                'strong_buy': strong_buy,
                'buy': buy,
                'hold': hold,
                'sell': sell,
                'strong_sell': strong_sell,
                'total_analysts': strong_buy + buy + hold + sell + strong_sell,
            })

        return normalized if normalized else None

    def _get_quote_page_price_targets(self, ticker_upper: str) -> Optional[Dict[str, Any]]:
        quote_summary = self._get_yahoo_analyst_quote_summary(ticker_upper)
        if not quote_summary:
            return None

        financial_data = quote_summary.get('financialData')
        if not isinstance(financial_data, dict):
            return None

        target_avg = _extract_raw_finance_value(financial_data.get('targetMeanPrice'))
        target_high = _extract_raw_finance_value(financial_data.get('targetHighPrice'))
        target_low = _extract_raw_finance_value(financial_data.get('targetLowPrice'))
        current = _extract_raw_finance_value(financial_data.get('currentPrice'))
        num_analysts = _extract_raw_finance_value(financial_data.get('numberOfAnalystOpinions'))

        if all(value is None for value in [target_avg, target_high, target_low]):
            return None

        return {
            'current': current,
            'targetAvg': target_avg,
            'targetHigh': target_high,
            'targetLow': target_low,
            'numberOfAnalysts': num_analysts,
        }

    def get_price_targets(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Retrieve analyst price targets for a stock.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Price targets with current, targetAvg, targetHigh,
                targetLow, and numberOfAnalysts fields.
        """
        ticker_upper = ticker.upper()
        cache_file = f"price_targets_{ticker_upper}.json"

        cached = _load_file_cache(cache_file)
        if _is_marked_cache_payload(cached, _PRICE_TARGETS_CACHE_KIND):
            return _unwrap_price_targets_cache_value(cached)
        if cached is not None and not _is_fallback_price_targets(cached):
            return cached

        if ticker_upper in _PRICE_TARGETS_CACHE:
            data, timestamp = _PRICE_TARGETS_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _get_price_targets_cache_ttl(data):
                return data

        try:
            logger.info(f"[YFINANCE] Attempting to fetch price targets for {ticker_upper}")
            yf = _import_yfinance_with_csrf_strategy()
            yf_ticker = yf.Ticker(ticker_upper)
            logger.info(f"[YFINANCE] Calling info attribute for {ticker_upper}")
            info = getattr(yf_ticker, 'info', None)

            if isinstance(info, dict):
                logger.info(f"[YFINANCE] Successfully got info dict for {ticker_upper}")
                target_avg = info.get('targetMeanPrice')
                target_high = info.get('targetHighPrice')
                target_low = info.get('targetLowPrice')
                current = info.get('currentPrice') or info.get('regularMarketPrice')
                num_analysts = info.get('numberOfAnalystOpinions')
                logger.info(f"[YFINANCE] Price targets for {ticker_upper}: avg={target_avg}, high={target_high}, low={target_low}, analysts={num_analysts}")

                if any(v is not None for v in [target_avg, target_high, target_low]):
                    result = {
                        'current': current,
                        'targetAvg': target_avg,
                        'targetHigh': target_high,
                        'targetLow': target_low,
                        'numberOfAnalysts': num_analysts,
                    }
                    _PRICE_TARGETS_CACHE[ticker_upper] = (result, datetime.now().timestamp())
                    _save_file_cache(cache_file, _wrap_price_targets_cache_value(result), _PRICE_TARGETS_CACHE_TTL)
                    return result

        except Exception as e:
            logger.error(f"Error fetching analyst price targets for {ticker}: {e}")

        quote_page_targets = self._get_quote_page_price_targets(ticker_upper)
        if quote_page_targets:
            _PRICE_TARGETS_CACHE[ticker_upper] = (quote_page_targets, datetime.now().timestamp())
            _save_file_cache(cache_file, _wrap_price_targets_cache_value(quote_page_targets), _PRICE_TARGETS_CACHE_TTL)
            return quote_page_targets

        quote_data = self.get_quote_extended(ticker)
        if quote_data:
            result = {
                'current': None,
                'targetAvg': None,
                'targetHigh': quote_data.get('fifty_two_week_high'),
                'targetLow': quote_data.get('fifty_two_week_low'),
                'numberOfAnalysts': None,
                'note': '52-week range (analyst targets unavailable)',
            }
            _PRICE_TARGETS_CACHE[ticker_upper] = (result, datetime.now().timestamp())
            _save_file_cache(cache_file, _wrap_price_targets_cache_value(result), _PRICE_TARGETS_FALLBACK_CACHE_TTL)
            return result

        _PRICE_TARGETS_CACHE[ticker_upper] = (None, datetime.now().timestamp())
        _save_file_cache(cache_file, _wrap_price_targets_cache_value(None), _PRICE_TARGETS_FALLBACK_CACHE_TTL)
        return None

    def get_latest_rating(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Retrieve the latest analyst rating for a stock.
        
        Args:
            ticker: Stock ticker symbol.
        
        Returns:
            dict: Latest rating data, or None (not implemented).
        """
        return None
