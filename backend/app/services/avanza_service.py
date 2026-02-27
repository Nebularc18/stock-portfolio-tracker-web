import os
import json
import time
import logging
import requests
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
MAPPING_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data')

try:
    os.makedirs(CACHE_DIR, exist_ok=True)
except PermissionError:
    CACHE_DIR = '/tmp/avanza_cache'
    os.makedirs(CACHE_DIR, exist_ok=True)

try:
    os.makedirs(MAPPING_DIR, exist_ok=True)
except PermissionError:
    pass

DIVIDENDS_CACHE_TTL = 86400
HISTORICAL_CACHE_TTL = 86400 * 7

MAPPING_FILE = "ticker_mapping.json"

AKTIEUTDELNINGAR_API = "https://aktieutdelningar.now.sh/api/stock"

_session = None


def get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
        })
    return _session


@dataclass
class AvanzaDividend:
    avanza_name: str
    ex_date: str
    amount: float
    currency: str
    payment_date: Optional[str] = None
    yahoo_ticker: Optional[str] = None
    instrument_id: Optional[str] = None
    dividend_type: Optional[str] = None


@dataclass
class TickerMapping:
    avanza_name: str
    yahoo_ticker: str
    instrument_id: Optional[str] = None
    manually_added: bool = False
    added_at: Optional[str] = None


def _load_json_file(filepath: str) -> Optional[Any]:
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load {filepath}: {e}")
        return None


def _save_json_file(filepath: str, data: Any):
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to save {filepath}: {e}")


def _load_cache(filename: str, ttl: int = DIVIDENDS_CACHE_TTL) -> Optional[Any]:
    filepath = os.path.join(CACHE_DIR, filename)
    data = _load_json_file(filepath)
    if data is None:
        return None
    
    timestamp = data.get('timestamp', 0)
    if time.time() - timestamp > ttl:
        return None
    
    return data.get('value')


def _save_cache(filename: str, value: Any):
    filepath = os.path.join(CACHE_DIR, filename)
    _save_json_file(filepath, {
        'value': value,
        'timestamp': time.time()
    })


class AvanzaService:
    def __init__(self):
        self.mapping: Dict[str, TickerMapping] = {}
        self._load_mappings()
    
    def _load_mappings(self):
        filepath = os.path.join(MAPPING_DIR, MAPPING_FILE)
        data = _load_json_file(filepath)
        if data:
            for item in data.get('mappings', []):
                mapping = TickerMapping(
                    avanza_name=item.get('avanza_name', ''),
                    yahoo_ticker=item.get('yahoo_ticker', ''),
                    instrument_id=item.get('instrument_id'),
                    manually_added=item.get('manually_added', False),
                    added_at=item.get('added_at')
                )
                self.mapping[mapping.avanza_name.lower()] = mapping
    
    def _save_mappings(self):
        filepath = os.path.join(MAPPING_DIR, MAPPING_FILE)
        data = {
            'mappings': [asdict(m) for m in self.mapping.values()]
        }
        _save_json_file(filepath, data)
    
    def add_manual_mapping(self, avanza_name: str, yahoo_ticker: str, instrument_id: Optional[str] = None):
        mapping = TickerMapping(
            avanza_name=avanza_name,
            yahoo_ticker=yahoo_ticker,
            instrument_id=instrument_id,
            manually_added=True,
            added_at=datetime.utcnow().isoformat()
        )
        self.mapping[avanza_name.lower()] = mapping
        self._save_mappings()
        logger.info(f"Added manual mapping: {avanza_name} -> {yahoo_ticker} (ID: {instrument_id})")
    
    def get_mapping(self, avanza_name: str) -> Optional[TickerMapping]:
        return self.mapping.get(avanza_name.lower())
    
    def get_mapping_by_ticker(self, yahoo_ticker: str) -> Optional[TickerMapping]:
        for m in self.mapping.values():
            if m.yahoo_ticker and m.yahoo_ticker.upper() == yahoo_ticker.upper():
                return m
        return None
    
    def get_unmapped_stocks(self) -> List[str]:
        return []
    
    def _fetch_stock_data(self, instrument_id: str) -> Optional[Dict[str, Any]]:
        session = get_session()
        
        try:
            url = f"{AKTIEUTDELNINGAR_API}?apiId={instrument_id}"
            response = session.get(url, timeout=15)
            
            if response.status_code != 200:
                logger.warning(f"API returned {response.status_code} for instrument {instrument_id}")
                return None
            
            data = response.json()
            
            if not data.get('data'):
                return None
            
            return data
            
        except Exception as e:
            logger.error(f"Failed to fetch stock data for {instrument_id}: {e}")
            return None
    
    def fetch_upcoming_dividends(self, use_cache: bool = True) -> List[AvanzaDividend]:
        cache_file = "avanza_upcoming_dividends.json"
        
        if use_cache:
            cached = _load_cache(cache_file)
            if cached:
                return [AvanzaDividend(**d) for d in cached]
        
        dividends = []
        
        for mapping in self.mapping.values():
            if mapping.instrument_id:
                stock_dividends = self._fetch_upcoming_for_stock(
                    mapping.instrument_id,
                    mapping.avanza_name,
                    mapping.yahoo_ticker
                )
                dividends.extend(stock_dividends)
        
        if dividends:
            _save_cache(cache_file, [asdict(d) for d in dividends])
            logger.info(f"Fetched {len(dividends)} upcoming dividends for mapped stocks")
        
        return dividends
    
    def _fetch_upcoming_for_stock(self, instrument_id: str, avanza_name: str, yahoo_ticker: Optional[str]) -> List[AvanzaDividend]:
        data = self._fetch_stock_data(instrument_id)
        
        if not data:
            return []
        
        dividends = []
        data_details = data.get('dataDetails', {})
        div_info = data_details.get('dividends', {})
        events = div_info.get('events', [])
        
        for event in events:
            try:
                amount = float(event.get('amount', 0))
                if amount <= 0:
                    continue
                
                ex_date = event.get('exDate', '')[:10] if event.get('exDate') else None
                if not ex_date:
                    continue
                
                dividends.append(AvanzaDividend(
                    avanza_name=avanza_name,
                    ex_date=ex_date,
                    amount=amount,
                    currency=event.get('currencyCode', 'SEK'),
                    payment_date=event.get('paymentDate', '')[:10] if event.get('paymentDate') else None,
                    yahoo_ticker=yahoo_ticker,
                    instrument_id=instrument_id,
                    dividend_type=event.get('dividendType')
                ))
            except (ValueError, TypeError) as e:
                logger.warning(f"Failed to parse dividend event: {e}")
        
        return dividends
    
    def get_stock_dividend(self, yahoo_ticker: str) -> Optional[AvanzaDividend]:
        if not yahoo_ticker.upper().endswith('.ST'):
            return None
        
        mapping = self.get_mapping_by_ticker(yahoo_ticker)
        if not mapping or not mapping.instrument_id:
            return None
        
        dividends = self._fetch_upcoming_for_stock(
            mapping.instrument_id,
            mapping.avanza_name,
            mapping.yahoo_ticker
        )
        
        today = datetime.now().strftime('%Y-%m-%d')
        for div in dividends:
            if div.ex_date >= today:
                return div
        
        return None
    
    def get_historical_dividends(self, yahoo_ticker: str, years: int = 5) -> List[Dict[str, Any]]:
        if not yahoo_ticker.upper().endswith('.ST'):
            return []
        
        cache_key = f"avanza_historical_{yahoo_ticker.replace('.', '_')}_{years}.json"
        cached = _load_cache(cache_key, HISTORICAL_CACHE_TTL)
        if cached:
            return cached
        
        mapping = self.get_mapping_by_ticker(yahoo_ticker)
        if not mapping or not mapping.instrument_id:
            return []
        
        data = self._fetch_stock_data(mapping.instrument_id)
        
        if not data:
            return []
        
        dividends = []
        data_details = data.get('dataDetails', {})
        div_info = data_details.get('dividends', {})
        past_events = div_info.get('pastEvents', [])
        
        cutoff_date = (datetime.now() - timedelta(days=years * 365)).strftime('%Y-%m-%d')
        
        for event in past_events:
            try:
                ex_date = event.get('exDate', '')[:10] if event.get('exDate') else None
                if not ex_date or ex_date < cutoff_date:
                    continue
                
                amount = float(event.get('amount', 0))
                if amount <= 0:
                    continue
                
                dividends.append({
                    'date': ex_date,
                    'amount': amount,
                    'currency': event.get('currencyCode', 'SEK'),
                    'payment_date': event.get('paymentDate', '')[:10] if event.get('paymentDate') else None,
                    'dividend_type': event.get('dividendType')
                })
            except (ValueError, TypeError) as e:
                logger.warning(f"Failed to parse past dividend event: {e}")
        
        dividends.sort(key=lambda x: x['date'], reverse=True)
        
        if dividends:
            _save_cache(cache_key, dividends)
            logger.info(f"Fetched {len(dividends)} historical dividends for {yahoo_ticker}")
        
        return dividends


avanza_service = AvanzaService()
