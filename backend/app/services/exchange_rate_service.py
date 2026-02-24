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
                logger.info(f"[YFINANCE] Fetching exchange rate for {key} via {EXCHANGE_PAIRS[key]}")
                ticker = yf.Ticker(EXCHANGE_PAIRS[key])
                price = ticker.info.get('currentPrice') or ticker.info.get('regularMarketPrice')
                if price:
                    logger.info(f"[YFINANCE] Successfully got exchange rate for {key}: {price}")
                    _cache[key] = (float(price), datetime.now().timestamp())
                    return float(price)
                else:
                    logger.warning(f"[YFINANCE] No price returned for exchange rate {key}")
            except Exception as e:
                logger.error(f"[YFINANCE] Error fetching exchange rate {key}: {e}")
        
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
    def get_rates_for_currencies(currencies: set, display_currency: str) -> Dict[str, Optional[float]]:
        needed_pairs = set()
        for currency in currencies:
            if currency != display_currency:
                key = f"{currency}_{display_currency}"
                inverse_key = f"{display_currency}_{currency}"
                if key in EXCHANGE_PAIRS:
                    needed_pairs.add(key)
                elif inverse_key in EXCHANGE_PAIRS:
                    needed_pairs.add(inverse_key)
        
        rates = {}
        now = datetime.now().timestamp()
        
        for pair in needed_pairs:
            if pair in _cache:
                rate, timestamp = _cache[pair]
                if now - timestamp < _cache_ttl:
                    rates[pair] = rate
                    continue
            
            try:
                ticker = yf.Ticker(EXCHANGE_PAIRS[pair])
                price = ticker.fast_info.last_price if hasattr(ticker, 'fast_info') else None
                if not price:
                    price = ticker.info.get('currentPrice') or ticker.info.get('regularMarketPrice')
                if price:
                    rates[pair] = float(price)
                    _cache[pair] = (float(price), now)
            except Exception as e:
                logger.error(f"Error fetching {pair}: {e}")
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
