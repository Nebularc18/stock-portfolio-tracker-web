import yfinance as yf
from typing import Dict, Optional
from datetime import datetime
import logging

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
}

_cache: Dict[str, tuple] = {}
_cache_ttl = 3600


class ExchangeRateService:
    @staticmethod
    def get_rate(from_currency: str, to_currency: str) -> Optional[float]:
        key = f"{from_currency}_{to_currency}"
        
        if key in _cache:
            rate, timestamp = _cache[key]
            if datetime.now().timestamp() - timestamp < _cache_ttl:
                return rate
        
        if key in EXCHANGE_PAIRS:
            try:
                ticker = yf.Ticker(EXCHANGE_PAIRS[key])
                price = ticker.info.get('currentPrice') or ticker.info.get('regularMarketPrice')
                if price:
                    _cache[key] = (float(price), datetime.now().timestamp())
                    return float(price)
            except Exception as e:
                logger.error(f"Error fetching exchange rate {key}: {e}")
        
        inverse_key = f"{to_currency}_{from_currency}"
        if inverse_key in EXCHANGE_PAIRS:
            try:
                ticker = yf.Ticker(EXCHANGE_PAIRS[inverse_key])
                price = ticker.info.get('currentPrice') or ticker.info.get('regularMarketPrice')
                if price:
                    rate = 1.0 / float(price)
                    _cache[key] = (rate, datetime.now().timestamp())
                    return rate
            except Exception as e:
                logger.error(f"Error fetching inverse exchange rate {inverse_key}: {e}")
        
        return None

    @staticmethod
    def get_all_rates() -> Dict[str, Optional[float]]:
        rates = {}
        for pair, symbol in EXCHANGE_PAIRS.items():
            try:
                ticker = yf.Ticker(symbol)
                price = ticker.info.get('currentPrice') or ticker.info.get('regularMarketPrice')
                rates[pair] = float(price) if price else None
            except Exception:
                rates[pair] = None
        return rates

    @staticmethod
    def convert(amount: float, from_currency: str, to_currency: str) -> Optional[float]:
        if from_currency == to_currency:
            return amount
        
        rate = ExchangeRateService.get_rate(from_currency, to_currency)
        if rate:
            return amount * rate
        return None
