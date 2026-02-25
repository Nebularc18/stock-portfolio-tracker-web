import os
import requests
import time
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

MONTHLY_CALL_LIMIT = 100
VERIFICATION_CACHE_TTL = 86400 * 30
USAGE_FILE = "marketstack_usage.json"


@dataclass
class DividendData:
    date: str
    amount: float
    currency: Optional[str] = None


@dataclass
class Discrepancy:
    date: str
    type: str
    yahoo_amount: Optional[float]
    marketstack_amount: Optional[float]
    difference: Optional[float]


@dataclass
class VerificationResult:
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
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w') as f:
            json.dump({'value': value, 'timestamp': time.time(), 'ttl': ttl}, f)
    except Exception as e:
        logger.warning(f"Failed to save cache file {filename}: {e}")


def _load_usage() -> Dict[str, Any]:
    filepath = os.path.join(CACHE_DIR, USAGE_FILE)
    if not os.path.exists(filepath):
        return {'month': datetime.now().strftime('%Y-%m'), 'calls_used': 0}
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        current_month = datetime.now().strftime('%Y-%m')
        if data.get('month') != current_month:
            return {'month': current_month, 'calls_used': 0}
        return data
    except Exception:
        return {'month': datetime.now().strftime('%Y-%m'), 'calls_used': 0}


def _save_usage(usage: Dict[str, Any]):
    filepath = os.path.join(CACHE_DIR, USAGE_FILE)
    try:
        with open(filepath, 'w') as f:
            json.dump(usage, f)
    except Exception as e:
        logger.warning(f"Failed to save usage file: {e}")


def _increment_usage() -> int:
    usage = _load_usage()
    usage['calls_used'] = usage.get('calls_used', 0) + 1
    _save_usage(usage)
    return usage['calls_used']


def get_remaining_calls() -> int:
    usage = _load_usage()
    return max(0, MONTHLY_CALL_LIMIT - usage.get('calls_used', 0))


class MarketstackService:
    def __init__(self):
        self.api_key = os.environ.get('MARKETSTACK_API_KEY')
        self.base_url = "https://api.marketstack.com/v2"
    
    def is_configured(self) -> bool:
        return bool(self.api_key)
    
    def _make_request(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Optional[Any]:
        if not self.api_key:
            logger.warning("Marketstack API key not configured")
            return None
        
        remaining = get_remaining_calls()
        if remaining <= 0:
            logger.warning("Marketstack monthly API limit reached")
            return None
        
        params = params or {}
        params['access_key'] = self.api_key
        
        try:
            url = f"{self.base_url}/{endpoint}"
            response = requests.get(url, params=params, timeout=15)
            
            if response.status_code == 429:
                logger.warning("Marketstack rate limit reached")
                return None
            
            if response.status_code != 200:
                logger.error(f"Marketstack API error: {response.status_code}")
                return None
            
            _increment_usage()
            return response.json()
            
        except Exception as e:
            logger.error(f"Marketstack request failed: {e}")
            return None
    
    def fetch_dividends(
        self, 
        ticker: str, 
        date_from: Optional[str] = None, 
        date_to: Optional[str] = None,
        use_cache: bool = True
    ) -> Optional[List[DividendData]]:
        ticker_upper = ticker.upper()
        
        effective_date_from = date_from
        if not effective_date_from:
            effective_date_from = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')
        
        effective_date_to = date_to or ''
        
        cache_key = f"{ticker_upper}_{effective_date_from}_{effective_date_to}".replace('-', '')
        cache_file = f"marketstack_dividends_{cache_key}.json"
        
        if use_cache:
            cached = _load_file_cache(cache_file)
            if cached is not None:
                return [DividendData(**d) for d in cached]
        
        params = {'symbols': ticker_upper}
        
        if date_from:
            params['date_from'] = date_from
        else:
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
        
        _save_file_cache(cache_file, [asdict(d) for d in dividends], VERIFICATION_CACHE_TTL)
        
        return dividends
    
    def verify_dividends(
        self, 
        ticker: str, 
        yahoo_dividends: List[Dict[str, Any]],
        use_cache: bool = True
    ) -> VerificationResult:
        ticker_upper = ticker.upper()
        cache_file = f"marketstack_verify_{ticker_upper}.json"
        
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
        usage = _load_usage()
        remaining = get_remaining_calls()
        
        return {
            'month': usage.get('month'),
            'calls_used': usage.get('calls_used', 0),
            'calls_limit': MONTHLY_CALL_LIMIT,
            'calls_remaining': remaining,
            'api_configured': self.is_configured()
        }
    
    def clear_cache(self, ticker: Optional[str] = None):
        if ticker:
            ticker_upper = ticker.upper()
            for filename in os.listdir(CACHE_DIR):
                if 'marketstack' not in filename:
                    continue
                parts = filename.replace('.json', '').split('_')
                if len(parts) >= 3 and parts[2].upper() == ticker_upper:
                    filepath = os.path.join(CACHE_DIR, filename)
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass


marketstack_service = MarketstackService()
