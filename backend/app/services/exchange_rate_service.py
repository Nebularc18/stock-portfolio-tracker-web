"""Exchange rate service for currency conversion.

This module provides functionality to fetch and cache exchange rates
from Yahoo Finance, supporting multiple currency pairs and conversions.
"""

from typing import Dict, Optional
from datetime import datetime
import logging

import requests

logger = logging.getLogger(__name__)

EXCHANGE_PAIRS = {
    "USD_SEK": "USDSEK=X",
    "SEK_USD": "SEKUSD=X",
    "USD_EUR": "USDEUR=X",
    "EUR_USD": "EURUSD=X",
    "USD_GBP": "USDGBP=X",
    "GBP_USD": "GBPUSD=X",
    "EUR_SEK": "EURSEK=X",
    "SEK_EUR": "SEKEUR=X",
    "USD_CAD": "USDCAD=X",
    "CAD_USD": "CADUSD=X",
    "USD_AUD": "USDAUD=X",
    "AUD_USD": "AUDUSD=X",
    "USD_CHF": "USDCHF=X",
    "CHF_USD": "CHFUSD=X",
    "USD_JPY": "USDJPY=X",
    "JPY_USD": "JPYUSD=X",
    "USD_HKD": "USDHKD=X",
    "HKD_USD": "HKDUSD=X",
    "USD_NZD": "USDNZD=X",
    "NZD_USD": "NZDUSD=X",
    "USD_KRW": "USDKRW=X",
    "KRW_USD": "KRWUSD=X",
    "EUR_GBP": "EURGBP=X",
    "GBP_EUR": "GBPEUR=X",
    "EUR_CAD": "EURCAD=X",
    "CAD_EUR": "CADEUR=X",
    "EUR_AUD": "EURAUD=X",
    "AUD_EUR": "AUDEUR=X",
    "EUR_CHF": "EURCHF=X",
    "CHF_EUR": "CHFEUR=X",
    "EUR_JPY": "EURJPY=X",
    "JPY_EUR": "JPYEUR=X",
    "SEK_GBP": "SEKGBP=X",
    "GBP_SEK": "GBPSEK=X",
    "SEK_CAD": "SEKCAD=X",
    "CAD_SEK": "CADSEK=X",
    "SEK_AUD": "SEKAUD=X",
    "AUD_SEK": "AUDSEK=X",
    "SEK_CHF": "SEKCHF=X",
    "CHF_SEK": "CHFSEK=X",
    "SEK_JPY": "SEKJPY=X",
    "JPY_SEK": "JPYSEK=X",
}

_cache: Dict[str, tuple] = {}
_cache_ttl = 3600
_session: Optional[requests.Session] = None


def _get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
        })
    return _session


def close_session() -> None:
    global _session
    if _session is not None:
        _session.close()
        _session = None


def _fetch_latest_price(symbol: str) -> Optional[float]:
    session = _get_session()
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
        response = session.get(url, timeout=5)
        response.raise_for_status()

        data = response.json()
        result = data.get('chart', {}).get('result')
        if not result:
            return None

        quote = result[0].get('indicators', {}).get('quote', [{}])[0]
        closes = quote.get('close', [])
        prices = [price for price in closes if price is not None]
        return float(prices[-1]) if prices else None
    except Exception as e:
        logger.error(f"Error fetching latest price for {symbol}: {e}")
        return None


class ExchangeRateService:
    """Service for fetching and caching exchange rates.
    
    Provides methods to get exchange rates between currencies,
    convert amounts between currencies, and batch fetch rates
    for multiple currency pairs.
    """
    
    @staticmethod
    def get_rate(from_currency: str, to_currency: str) -> Optional[float]:
        """Get exchange rate between two currencies.
        
        Args:
            from_currency: Source currency code (e.g., 'USD').
            to_currency: Target currency code (e.g., 'SEK').
        
        Returns:
            float: Exchange rate, or None if unavailable.
        """
        key = f"{from_currency}_{to_currency}"
        
        if key in _cache:
            rate, timestamp = _cache[key]
            if datetime.now().timestamp() - timestamp < _cache_ttl:
                return rate
        
        if key in EXCHANGE_PAIRS:
            try:
                logger.info(f"Fetching exchange rate for {key} via {EXCHANGE_PAIRS[key]}")
                price = _fetch_latest_price(EXCHANGE_PAIRS[key])
                if price:
                    logger.info(f"Successfully got exchange rate for {key}: {price}")
                    _cache[key] = (float(price), datetime.now().timestamp())
                    return float(price)
                else:
                    logger.warning(f"No price returned for exchange rate {key}")
            except Exception as e:
                logger.error(f"Error fetching exchange rate {key}: {e}")
        
        inverse_key = f"{to_currency}_{from_currency}"
        if inverse_key in EXCHANGE_PAIRS:
            try:
                price = _fetch_latest_price(EXCHANGE_PAIRS[inverse_key])
                if price:
                    rate = 1.0 / float(price)
                    _cache[key] = (rate, datetime.now().timestamp())
                    return rate
            except Exception as e:
                logger.error(f"Error fetching inverse exchange rate {inverse_key}: {e}")
        
        return None

    @staticmethod
    def get_rates_for_currencies(currencies: set, display_currency: str) -> Dict[str, Optional[float]]:
        """Get exchange rates for multiple currencies to display currency.
        
        Args:
            currencies: Set of currency codes to convert from.
            display_currency: Target currency code.
        
        Returns:
            dict: Mapping of currency pairs to exchange rates.
        """
        needed_pairs = set()

        def add_pair(from_currency: str, to_currency: str) -> bool:
            if from_currency == to_currency:
                return True

            key = f"{from_currency}_{to_currency}"
            inverse_key = f"{to_currency}_{from_currency}"
            if key in EXCHANGE_PAIRS:
                needed_pairs.add(key)
                return True
            elif inverse_key in EXCHANGE_PAIRS:
                needed_pairs.add(inverse_key)
                return True

            return False

        for currency in currencies:
            if currency == display_currency:
                continue

            found = add_pair(currency, display_currency)

            if not found and currency != "SEK" and display_currency != "SEK":
                add_pair(currency, "SEK")
                add_pair("SEK", display_currency)
        
        rates = {}
        now = datetime.now().timestamp()
        
        for pair in needed_pairs:
            if pair in _cache:
                rate, timestamp = _cache[pair]
                if now - timestamp < _cache_ttl:
                    rates[pair] = rate
                    continue
            
            try:
                price = _fetch_latest_price(EXCHANGE_PAIRS[pair])
                if price:
                    rates[pair] = float(price)
                    _cache[pair] = (float(price), now)
                else:
                    rates[pair] = None
            except Exception as e:
                logger.error(f"Error fetching {pair}: {e}")
                rates[pair] = None
        
        return rates

    @staticmethod
    def convert(amount: float, from_currency: str, to_currency: str) -> Optional[float]:
        """Convert an amount from one currency to another.
        
        Args:
            amount: The monetary amount to convert.
            from_currency: Source currency code.
            to_currency: Target currency code.
        
        Returns:
            float: Converted amount, or None if rate unavailable.
        """
        if from_currency == to_currency:
            return amount
        
        rate = ExchangeRateService.get_rate(from_currency, to_currency)
        if rate:
            return amount * rate
        return None
