import os
import json
import time
import logging
import requests
import tempfile
import threading
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
MAPPING_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data')

try:
    os.makedirs(CACHE_DIR, exist_ok=True)
except PermissionError:
    CACHE_DIR = tempfile.mkdtemp(prefix='avanza_cache_')
    os.chmod(CACHE_DIR, 0o700)

try:
    os.makedirs(MAPPING_DIR, exist_ok=True)
except PermissionError as e:
    logger.warning(f"Cannot create mapping directory {MAPPING_DIR}: {e}")

DIVIDENDS_CACHE_TTL = 86400
HISTORICAL_CACHE_TTL = 86400 * 7
STOCK_DATA_CACHE_TTL = 300
MAX_STOCK_CACHE_SIZE = 256

MAPPING_FILE = "ticker_mapping.json"

AKTIEUTDELNINGAR_API = "https://aktieutdelningar.now.sh/api/stock"

_session = None


def get_session() -> requests.Session:
    """
    Provide a singleton requests.Session configured with default headers.
    
    Returns:
        requests.Session: A cached HTTP session with a predefined `User-Agent` and `Accept: application/json` header.
    """
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
    """
    Load and parse a JSON file from disk if it exists.
    
    Parameters:
        filepath (str): Path to the JSON file to read.
    
    Returns:
        The parsed JSON data, or `None` if the file does not exist or an error occurs while reading or parsing it.
    """
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load {filepath}: {e}")
        return None


def _save_json_file(filepath: str, data: Any) -> bool:
    """
    Write JSON-serializable `data` to `filepath` using UTF-8 encoding and a two-space indent.
    
    Parameters:
        filepath (str): Destination filesystem path for the JSON file.
        data (Any): JSON-serializable object to write.
    
    Returns:
        bool: True on success, False on failure.
    
    Notes:
        Non-ASCII characters are preserved (`ensure_ascii=False`). Errors encountered during write are logged and return False.
    """
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.exception(f"Failed to save {filepath}: {e}")
        return False


def _load_cache(filename: str, ttl: int = DIVIDENDS_CACHE_TTL) -> Optional[Any]:
    """
    Load a cached value from disk if present and not older than the given TTL.
    
    Parameters:
        filename (str): Name of the cache file to read (located in the configured cache directory).
        ttl (int): Time-to-live in seconds; cached entries older than this are considered expired.
    
    Returns:
        The stored cached value if present and fresh, or `None` if the cache is missing or expired.
    """
    filepath = os.path.join(CACHE_DIR, filename)
    data = _load_json_file(filepath)
    if data is None:
        return None
    
    timestamp = data.get('timestamp', 0)
    if time.time() - timestamp > ttl:
        return None
    
    return data.get('value')


def _save_cache(filename: str, value: Any):
    """
    Save a value to the module cache directory with a timestamp.
    
    Parameters:
        filename (str): Filename to create inside the cache directory (relative to CACHE_DIR).
        value (Any): JSON-serializable object to store; it will be saved alongside a UNIX timestamp.
    """
    filepath = os.path.join(CACHE_DIR, filename)
    _save_json_file(filepath, {
        'value': value,
        'timestamp': time.time()
    })


class AvanzaService:
    def __init__(self):
        """
        Initialize the AvanzaService instance and load persisted ticker mappings.
        
        Creates an empty mapping dictionary for Avanza names to TickerMapping objects and populates it from the persistent mapping file if available.
        """
        self.mapping: Dict[str, TickerMapping] = {}
        self._lock = threading.RLock()
        self._stock_data_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
        self._load_mappings()

    def _fetch_stock_data_with_cache(self, instrument_id: str) -> Optional[Dict[str, Any]]:
        """Fetch stock data with a short-lived in-memory cache by instrument ID."""
        now = time.time()
        try:
            expired_keys = [
                key for key, cached in self._stock_data_cache.items()
                if (now - cached[0]) >= STOCK_DATA_CACHE_TTL
            ]
            for key in expired_keys:
                self._stock_data_cache.pop(key, None)

            cached = self._stock_data_cache.get(instrument_id)
            if cached and (now - cached[0]) < STOCK_DATA_CACHE_TTL:
                return cached[1]
        except Exception as cache_err:
            logger.debug(f"Stock data cache lookup failed for {instrument_id}: {cache_err}")

        data = self._fetch_stock_data(instrument_id)
        if data:
            if len(self._stock_data_cache) >= MAX_STOCK_CACHE_SIZE:
                oldest_keys = sorted(
                    self._stock_data_cache.items(),
                    key=lambda item: item[1][0]
                )
                while len(self._stock_data_cache) >= MAX_STOCK_CACHE_SIZE and oldest_keys:
                    oldest_key, _ = oldest_keys.pop(0)
                    self._stock_data_cache.pop(oldest_key, None)
            self._stock_data_cache[instrument_id] = (now, data)
        return data
    
    def _load_mappings(self):
        """
        Load ticker mappings from the mappings file and populate self.mapping.
        
        Reads the mappings file (MAPPING_FILE in MAPPING_DIR) if present, converts each mapping entry into a TickerMapping, and stores them in self.mapping keyed by the lowercase Avanza name. If the file is missing or invalid, self.mapping is left unchanged.
        """
        with self._lock:
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
        """
        Persist the current ticker mappings to the configured mapping file.
        
        Writes the service's in-memory mapping entries to MAPPING_DIR/MAPPING_FILE in JSON form under the top-level key "mappings".
        
        Returns:
            bool: True on success, False on failure.
        """
        with self._lock:
            filepath = os.path.join(MAPPING_DIR, MAPPING_FILE)
            data = {
                'mappings': [asdict(m) for m in self.mapping.values()]
            }
            return _save_json_file(filepath, data)
    
    def add_manual_mapping(self, avanza_name: str, yahoo_ticker: str, instrument_id: Optional[str] = None):
        """
        Add a manual mapping between an Avanza instrument name and a Yahoo ticker and persist it.
        
        Parameters:
            avanza_name (str): The Avanza instrument name to map. The mapping is stored keyed by the lowercased value.
            yahoo_ticker (str): The corresponding Yahoo ticker.
            instrument_id (Optional[str]): Optional Avanza instrument identifier to associate with the mapping. When provided, it will be saved with the mapping.
        
        Raises:
            IOError: If the mapping could not be persisted to disk.
        """
        with self._lock:
            mapping = TickerMapping(
                avanza_name=avanza_name,
                yahoo_ticker=yahoo_ticker,
                instrument_id=instrument_id,
                manually_added=True,
                added_at=datetime.utcnow().isoformat()
            )
            self.mapping[avanza_name.lower()] = mapping
            if not self._save_mappings():
                raise IOError(f"Failed to persist mapping for {avanza_name}")
            logger.info(f"Added manual mapping: {avanza_name} -> {yahoo_ticker} (ID: {instrument_id})")
    
    def get_mapping(self, avanza_name: str) -> Optional[TickerMapping]:
        """
        Retrieve the ticker mapping for a given Avanza instrument name using a case-insensitive lookup.
        
        Parameters:
            avanza_name (str): Avanza instrument name to look up.
        
        Returns:
            Optional[TickerMapping]: The corresponding TickerMapping if found, `None` otherwise.
        """
        return self.mapping.get(avanza_name.lower())
    
    def get_mapping_by_ticker(self, yahoo_ticker: str) -> Optional[TickerMapping]:
        """
        Finds the stored ticker mapping that matches the given Yahoo ticker, case-insensitively.
        
        Parameters:
            yahoo_ticker (str): Yahoo-format ticker to look up; matching is performed case-insensitively.
        
        Returns:
            Optional[TickerMapping]: The corresponding TickerMapping if a match is found, `None` otherwise.
        """
        for m in self.mapping.values():
            if m.yahoo_ticker and m.yahoo_ticker.upper() == yahoo_ticker.upper():
                return m
        return None
    
    def get_unmapped_stocks(self) -> List[str]:
        """
        List Avanza stock names that have no associated Yahoo ticker mapping.
        
        Returns:
            List[str]: Avanza stock names that lack a mapped Yahoo ticker. Currently always returns an empty list (placeholder).
        """
        return []
    
    def _fetch_stock_data(self, instrument_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetches raw stock data from the Avanza dividends API for the given instrument identifier.
        
        Parameters:
            instrument_id (str): Avanza instrument identifier used when querying the external API.
        
        Returns:
            dict: Parsed JSON response containing the API data when successful and the response includes a 'data' key.
            `None` if the request failed, returned a non-200 status, or the response lacked a 'data' field.
        """
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
        """
        Return upcoming dividend entries for all mapped stocks.
        
        If use_cache is True, attempts to load and return previously cached dividend data. May update the local cache when fresh dividend data is fetched.
        
        Parameters:
        	use_cache (bool): Whether to use a cached result if available.
        
        Returns:
        	List[AvanzaDividend]: A list of upcoming AvanzaDividend objects for mapped stocks; empty list if none are found.
        """
        cache_file = "avanza_upcoming_dividends.json"
        
        if use_cache:
            cached = _load_cache(cache_file)
            if cached is not None:
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
        
        _save_cache(cache_file, [asdict(d) for d in dividends])
        logger.info(f"Fetched {len(dividends)} upcoming dividends for mapped stocks")
        
        return dividends
    
    def _fetch_upcoming_for_stock(self, instrument_id: str, avanza_name: str, yahoo_ticker: Optional[str]) -> List[AvanzaDividend]:
        """
        Extracts upcoming dividend events for a stock from fetched Avanza data.
        
        Parameters:
            instrument_id (str): Avanza instrument identifier used to fetch the stock data.
            avanza_name (str): Avanza display name to set on each returned AvanzaDividend.
            yahoo_ticker (Optional[str]): Optional Yahoo ticker to include on each returned AvanzaDividend.
        
        Returns:
            List[AvanzaDividend]: A list of AvanzaDividend instances for events with a positive amount and a valid ex-date; returns an empty list if no valid events are found or data is unavailable.
        """
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
    
    def get_stock_dividends(self, yahoo_ticker: str) -> List[AvanzaDividend]:
        """
        Return all upcoming Avanza dividends for a mapped Yahoo ticker.

        Returns:
            List[AvanzaDividend]: Upcoming dividends (today or later), sorted by `ex_date`.
            Returns an empty list when no mapping/instrument_id exists or no upcoming
            events are available.
        """
        mapping = self.get_mapping_by_ticker(yahoo_ticker)
        if not mapping:
            logger.debug(f"get_stock_dividends: No Avanza mapping found for {yahoo_ticker}")
            return []

        if not mapping.instrument_id:
            logger.warning(
                f"get_stock_dividends: Avanza mapping for {yahoo_ticker} has no instrument_id "
                f"(avanza_name={mapping.avanza_name})"
            )
            return []

        logger.debug(
            f"get_stock_dividends: Found mapping for {yahoo_ticker} -> "
            f"instrument_id={mapping.instrument_id}, avanza_name={mapping.avanza_name}"
        )

        dividends = self._fetch_upcoming_for_stock(
            mapping.instrument_id,
            mapping.avanza_name,
            mapping.yahoo_ticker
        )

        today = datetime.utcnow().strftime('%Y-%m-%d')
        upcoming = [div for div in dividends if div.ex_date >= today]
        upcoming.sort(key=lambda d: d.ex_date)

        if not upcoming:
            logger.debug(
                f"get_stock_dividends: No upcoming dividends found for {yahoo_ticker} "
                f"(fetched {len(dividends)} total dividends)"
            )

        return upcoming

    def get_stock_dividend(self, yahoo_ticker: str) -> Optional[AvanzaDividend]:
        """
        Return the nearest upcoming Avanza dividend for a mapped Yahoo ticker.

        Returns:
            Optional[AvanzaDividend]: The nearest upcoming dividend event or `None` if
            no upcoming mapped Avanza dividend exists.
        """
        upcoming = self.get_stock_dividends(yahoo_ticker)
        return upcoming[0] if upcoming else None

    def get_stock_dividends_for_year(self, yahoo_ticker: str, year: int) -> List[AvanzaDividend]:
        """
        Return all mapped Avanza dividend events whose payout date falls in the given year.

        This method is intended for current-year dashboard views where both already-paid
        and upcoming events are needed. It does not enforce Swedish suffix rules.

        Parameters:
            yahoo_ticker (str): Yahoo ticker to resolve via stored mapping.
            year (int): Target payout year.

        Returns:
            List[AvanzaDividend]: Parsed events sorted by payout date then ex-date.
        """
        mapping = self.get_mapping_by_ticker(yahoo_ticker)
        if not mapping or not mapping.instrument_id:
            return []

        data = self._fetch_stock_data_with_cache(mapping.instrument_id)
        if not data:
            return []

        dividends: List[AvanzaDividend] = []
        seen = set()

        data_details = data.get('dataDetails', {})
        div_info = data_details.get('dividends', {})
        events = div_info.get('events', [])
        past_events = div_info.get('pastEvents', [])

        for event in [*past_events, *events]:
            try:
                amount = float(event.get('amount', 0))
                if amount <= 0:
                    continue

                ex_date = event.get('exDate', '')[:10] if event.get('exDate') else None
                if not ex_date:
                    continue

                payment_date = event.get('paymentDate', '')[:10] if event.get('paymentDate') else None
                payout_date = payment_date or ex_date
                if not payout_date or not payout_date.startswith(f"{year}-"):
                    continue

                key = (
                    ex_date,
                    payment_date,
                    amount,
                    event.get('currencyCode', 'SEK'),
                    event.get('dividendType')
                )
                if key in seen:
                    continue
                seen.add(key)

                dividends.append(AvanzaDividend(
                    avanza_name=mapping.avanza_name,
                    ex_date=ex_date,
                    amount=amount,
                    currency=event.get('currencyCode', 'SEK'),
                    payment_date=payment_date,
                    yahoo_ticker=mapping.yahoo_ticker,
                    instrument_id=mapping.instrument_id,
                    dividend_type=event.get('dividendType')
                ))
            except (ValueError, TypeError) as e:
                logger.warning(f"Failed to parse mapped yearly dividend event: {e}")

        dividends.sort(key=lambda d: ((d.payment_date or d.ex_date), d.ex_date))
        return dividends
    
    def get_historical_dividends(self, yahoo_ticker: str, years: int = 5) -> List[Dict[str, Any]]:
        """
        Return historical dividend records for a Swedish stock ticker within a given lookback window.
        
        Parameters:
            yahoo_ticker (str): Yahoo-format ticker for the stock; must end with ".ST". Returns empty list for other tickers.
            years (int): Number of years to include counting backward from today.
        
        Returns:
            List[Dict[str, Any]]: A list of dividend dictionaries sorted by date (newest first). Each dictionary contains:
                - date (str): Ex-dividend date in "YYYY-MM-DD" format.
                - amount (float): Dividend amount (positive).
                - currency (str): Currency code (e.g., "SEK").
                - payment_date (Optional[str]): Payment date in "YYYY-MM-DD" format or None.
                - dividend_type (Optional[str]): Type/category of the dividend.
        """
        if not yahoo_ticker.upper().endswith('.ST'):
            logger.debug(f"get_historical_dividends: {yahoo_ticker} is not a Swedish ticker (.ST), skipping Avanza lookup")
            return []
        
        cache_key = f"avanza_historical_{yahoo_ticker.replace('.', '_')}_{years}.json"
        cached = _load_cache(cache_key, HISTORICAL_CACHE_TTL)
        if cached is not None:
            logger.debug(f"get_historical_dividends: Returning cached data for {yahoo_ticker}")
            return cached
        
        mapping = self.get_mapping_by_ticker(yahoo_ticker)
        if not mapping:
            logger.debug(f"get_historical_dividends: No Avanza mapping found for {yahoo_ticker}")
            return []
        
        if not mapping.instrument_id:
            logger.warning(f"get_historical_dividends: Avanza mapping for {yahoo_ticker} has no instrument_id")
            return []
        
        logger.debug(f"get_historical_dividends: Fetching historical dividends for {yahoo_ticker} (instrument_id={mapping.instrument_id})")
        
        data = self._fetch_stock_data(mapping.instrument_id)
        
        if not data:
            logger.warning(f"get_historical_dividends: No data returned from Avanza API for {yahoo_ticker}")
            return []
        
        dividends = []
        data_details = data.get('dataDetails', {})
        div_info = data_details.get('dividends', {})
        past_events = div_info.get('pastEvents', [])
        
        logger.debug(f"get_historical_dividends: Found {len(past_events)} past dividend events for {yahoo_ticker}")
        
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
