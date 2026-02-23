import requests
import json
import importlib
import os
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

def _load_file_cache(filename: str) -> Optional[Any]:
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
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w') as f:
            json.dump({'value': value, 'timestamp': datetime.now().timestamp(), 'ttl': ttl}, f)
    except Exception as e:
        logger.warning(f"Failed to save cache {filename}: {e}")

CURRENCY_MAP = {
    ".ST": "SEK", ".SE": "SEK", ".TO": "CAD", ".L": "GBP",
    ".PA": "EUR", ".DE": "EUR", ".AM": "EUR", ".BR": "EUR",
    ".MI": "EUR", ".AS": "EUR", ".SW": "CHF", ".AX": "AUD",
    ".NZ": "NZD", ".HK": "HKD", ".T": "JPY", ".KS": "KRW",
}

_TICKER_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300

_DIVIDEND_CACHE: Dict[str, tuple] = {}
_DIVIDEND_CACHE_TTL = 86400 * 30

_sector_cache: Dict[str, Optional[str]] = {}

_ANALYST_CACHE: Dict[str, tuple] = {}
_ANALYST_CACHE_TTL = 3600

_PRICE_TARGETS_CACHE: Dict[str, tuple] = {}
_PRICE_TARGETS_CACHE_TTL = 3600

_session = None

def get_session():
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
    ticker_upper = ticker.upper()
    for suffix, currency in CURRENCY_MAP.items():
        if ticker_upper.endswith(suffix):
            return currency
    return "USD"


def fetch_yahoo_quote(ticker: str) -> Optional[Dict]:
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
        self.cache_ttl = 300

    def fetch_ticker_data(self, ticker: str) -> Optional[Dict]:
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
        data = self.fetch_ticker_data(ticker)
        return data is not None and data.get('current_price') is not None

    def get_stock_info(self, ticker: str) -> Optional[dict]:
        return self.fetch_ticker_data(ticker)

    def get_stock_price(self, ticker: str) -> Optional[float]:
        data = self.fetch_ticker_data(ticker)
        return data.get('current_price') if data else None

    def get_previous_close(self, ticker: str) -> Optional[float]:
        data = self.fetch_ticker_data(ticker)
        return data.get('previous_close') if data else None

    def get_multiple_prices(self, tickers: list) -> dict:
        results = {}
        for ticker in tickers:
            data = self.fetch_ticker_data(ticker)
            results[ticker.upper()] = data.get('current_price') if data else None
        return results

    def get_sector(self, ticker: str, stock=None) -> Optional[str]:
        data = self.fetch_ticker_data(ticker)
        return data.get('sector') if data else None

    def get_dividends(self, ticker: str, years: int = 5) -> list:
        ticker = ticker.upper()
        cache_key = f"{ticker}_{years}"
        cache_file = f"dividends_{cache_key}.json"
        
        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached
        
        if cache_key in _DIVIDEND_CACHE:
            cached_data, timestamp = _DIVIDEND_CACHE[cache_key]
            if datetime.now().timestamp() - timestamp < _DIVIDEND_CACHE_TTL:
                return cached_data
        
        session = get_session()
        
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range={years}y&events=div"
            response = session.get(url, timeout=15)
            
            if response.status_code != 200:
                return []
            
            data = response.json()
            
            if 'chart' not in data or 'result' not in data['chart'] or not data['chart']['result']:
                return []
            
            result = data['chart']['result'][0]
            events = result.get('events', {})
            dividends = events.get('dividends', {})
            
            if not dividends:
                return []
            
            result_list = []
            for ts, div_data in dividends.items():
                result_list.append({
                    'date': datetime.fromtimestamp(div_data['date'], tz=timezone.utc).strftime('%Y-%m-%d'),
                    'amount': div_data['amount'],
                    'currency': None,
                })
            
            result_list.sort(key=lambda x: x['date'], reverse=True)
            
            _DIVIDEND_CACHE[cache_key] = (result_list, datetime.now().timestamp())
            _save_file_cache(cache_file, result_list, _DIVIDEND_CACHE_TTL)
            return result_list
            
        except Exception as e:
            logger.error(f"Error fetching dividends for {ticker}: {e}")
            return []

    def get_upcoming_dividends(self, ticker: str) -> Optional[List[Dict[str, Any]]]:
        return []

    def get_quote_extended(self, ticker: str) -> Optional[Dict[str, Any]]:
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
        ticker_upper = ticker.upper()
        cache_file = f"analyst_recs_{ticker_upper}.json"

        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached

        if ticker_upper in _ANALYST_CACHE:
            data, timestamp = _ANALYST_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _ANALYST_CACHE_TTL:
                return data

        try:
            yf = importlib.import_module('yfinance')
            yf_ticker = yf.Ticker(ticker_upper)
            
            recs_df = getattr(yf_ticker, 'recommendations', None)
            if recs_df is None or (hasattr(recs_df, 'empty') and recs_df.empty):
                recs_df = getattr(yf_ticker, 'recommendations_summary', None)

            if recs_df is None:
                _ANALYST_CACHE[ticker_upper] = (None, datetime.now().timestamp())
                return None

            if hasattr(recs_df, 'empty') and recs_df.empty:
                _ANALYST_CACHE[ticker_upper] = (None, datetime.now().timestamp())
                return None

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

            if not normalized:
                _ANALYST_CACHE[ticker_upper] = (None, datetime.now().timestamp())
                return None

            _ANALYST_CACHE[ticker_upper] = (normalized, datetime.now().timestamp())
            _save_file_cache(cache_file, normalized, _ANALYST_CACHE_TTL)
            return normalized

        except Exception as e:
            logger.error(f"Error fetching analyst recommendations for {ticker}: {e}")
            _ANALYST_CACHE[ticker_upper] = (None, datetime.now().timestamp())
            return None

    def get_price_targets(self, ticker: str) -> Optional[Dict[str, Any]]:
        ticker_upper = ticker.upper()
        cache_file = f"price_targets_{ticker_upper}.json"

        cached = _load_file_cache(cache_file)
        if cached is not None:
            return cached

        if ticker_upper in _PRICE_TARGETS_CACHE:
            data, timestamp = _PRICE_TARGETS_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _PRICE_TARGETS_CACHE_TTL:
                return data

        try:
            yf = importlib.import_module('yfinance')
            yf_ticker = yf.Ticker(ticker_upper)
            info = getattr(yf_ticker, 'info', None)

            if isinstance(info, dict):
                target_avg = info.get('targetMeanPrice')
                target_high = info.get('targetHighPrice')
                target_low = info.get('targetLowPrice')
                current = info.get('currentPrice') or info.get('regularMarketPrice')
                num_analysts = info.get('numberOfAnalystOpinions')

                if any(v is not None for v in [target_avg, target_high, target_low]):
                    result = {
                        'current': current,
                        'targetAvg': target_avg,
                        'targetHigh': target_high,
                        'targetLow': target_low,
                        'numberOfAnalysts': num_analysts,
                    }
                    _PRICE_TARGETS_CACHE[ticker_upper] = (result, datetime.now().timestamp())
                    _save_file_cache(cache_file, result, _PRICE_TARGETS_CACHE_TTL)
                    return result

        except Exception as e:
            logger.error(f"Error fetching analyst price targets for {ticker}: {e}")

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
            return result

        _PRICE_TARGETS_CACHE[ticker_upper] = (None, datetime.now().timestamp())
        return None

    def get_latest_rating(self, ticker: str) -> Optional[Dict[str, Any]]:
        return None
