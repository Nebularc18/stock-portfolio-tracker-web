import requests
import json
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CURRENCY_MAP = {
    ".ST": "SEK", ".SE": "SEK", ".TO": "CAD", ".L": "GBP",
    ".PA": "EUR", ".DE": "EUR", ".AM": "EUR", ".BR": "EUR",
    ".MI": "EUR", ".AS": "EUR", ".SW": "CHF", ".AX": "AUD",
    ".NZ": "NZD", ".HK": "HKD", ".T": "JPY", ".KS": "KRW",
}

_TICKER_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300

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
        
        return result_data
        
    except Exception as e:
        logger.error(f"Error fetching {ticker} from Yahoo: {e}")
        return None


def fetch_yahoo_sector(ticker: str) -> Optional[str]:
    ticker = ticker.upper()
    session = get_session()
    
    try:
        url = f"https://query1.finance.yahoo.com/v1/finance/search?q={ticker}"
        response = session.get(url, timeout=10)
        
        if response.status_code != 200:
            return None
        
        data = response.json()
        
        if 'quotes' in data and data['quotes']:
            for quote in data['quotes']:
                if quote.get('symbol', '').upper() == ticker:
                    return quote.get('sector')
            return data['quotes'][0].get('sector')
        
        return None
        
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

    def get_analyst_recommendations(self, ticker: str) -> Optional[dict]:
        return None

    def get_price_targets(self, ticker: str) -> Optional[Dict[str, Any]]:
        quote_data = self.get_quote_extended(ticker)
        if quote_data:
            return {
                'current': None,
                'targetAvg': None,
                'targetHigh': quote_data.get('fifty_two_week_high'),
                'targetLow': quote_data.get('fifty_two_week_low'),
                'numberOfAnalysts': None,
                'note': '52-week range (analyst targets unavailable)',
            }
        return None

    def get_latest_rating(self, ticker: str) -> Optional[Dict[str, Any]]:
        return None
