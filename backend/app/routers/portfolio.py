"""Portfolio summary and analytics API endpoints.

This module provides API endpoints for portfolio summaries, historical
performance, distribution analysis, and bulk refresh operations.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from typing import List, Optional
import hashlib
import json
import logging
import os
import tempfile
import threading

from app.main import get_db, get_current_user, User, Stock, PortfolioHistory, UserSettings, StockPriceHistory
from app.services.brandfetch_service import brandfetch_service
from app.services.exchange_rate_service import ExchangeRateService
from app.services.position_service import calculate_position_cost_basis, calculate_position_snapshot, get_quantity_held_on_date, has_position_history, normalize_position_entries
from app.utils.time import utc_now

router = APIRouter()
logger = logging.getLogger(__name__)

_CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
PORTFOLIO_UPCOMING_DIVIDENDS_CACHE_TTL = 21600
PORTFOLIO_UPCOMING_DIVIDENDS_WAIT_TIMEOUT = 15
_portfolio_upcoming_dividends_inflight_lock = threading.Lock()
_portfolio_upcoming_dividends_inflight: dict[int, threading.Event] = {}


def _load_json_cache(filename: str, ttl: int) -> dict | None:
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, filename)
        if not os.path.exists(filepath):
            return None
        with open(filepath, 'r', encoding='utf-8') as f:
            payload = json.load(f)
        cached_at = payload.get('cached_at', 0)
        if datetime.now(timezone.utc).timestamp() - cached_at >= ttl:
            return None
        return payload
    except Exception:
        logger.exception("Failed to load cache file %s", filename)
        return None


def _save_json_cache(filename: str, value: dict):
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        filepath = os.path.join(_CACHE_DIR, filename)
        fd, temp_path = tempfile.mkstemp(dir=_CACHE_DIR, prefix=f"{filename}.", suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({
                    'cached_at': datetime.now(timezone.utc).timestamp(),
                    **value,
                }, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, filepath)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
    except Exception:
        logger.exception("Failed to save cache file %s", filename)


def _portfolio_upcoming_dividends_cache_key(user_id: int) -> str:
    return f"portfolio_upcoming_dividends_{user_id}.json"


def _begin_portfolio_upcoming_dividends_refresh(user_id: int) -> tuple[threading.Event, bool]:
    with _portfolio_upcoming_dividends_inflight_lock:
        inflight = _portfolio_upcoming_dividends_inflight.get(user_id)
        if inflight is not None:
            return inflight, False
        event = threading.Event()
        _portfolio_upcoming_dividends_inflight[user_id] = event
        return event, True


def _finish_portfolio_upcoming_dividends_refresh(user_id: int, event: threading.Event) -> None:
    with _portfolio_upcoming_dividends_inflight_lock:
        current = _portfolio_upcoming_dividends_inflight.get(user_id)
        if current is event:
            _portfolio_upcoming_dividends_inflight.pop(user_id, None)
    event.set()


def _build_upcoming_dividends_cache_fingerprint(
    stocks: list[Stock],
    display_currency: str,
    current_day: date,
    rates_snapshot: dict[str, float | None],
    mapping_snapshot: dict[str, dict | None] | None = None,
) -> str:
    """
    Builds a deterministic cache fingerprint representing the portfolio state relevant to upcoming dividends.
    
    The fingerprint covers the normalized set of provided stocks (including normalized position entries), the exchange rates snapshot, the display currency, the current day, and an optional Avanza mapping snapshot; identical inputs always produce the same fingerprint.
    
    Parameters:
        stocks (list[Stock]): Portfolio stocks to include in the fingerprint; position entries are normalized before inclusion.
        display_currency (str): Currency used for display/conversion.
        current_day (date): Reference date applied to the fingerprint.
        rates_snapshot (dict[str, float | None]): Mapping of currency-pair keys to exchange rates (values may be None).
        mapping_snapshot (dict[str, dict | None] | None): Optional per-ticker Avanza mapping metadata to include (may be None).
    
    Returns:
        str: Hex-encoded SHA-256 fingerprint string representing the serialized, normalized inputs.
    """
    normalized_stocks = []
    for stock in sorted(stocks, key=lambda item: item.ticker or ''):
        normalized_stocks.append({
            'id': stock.id,
            'ticker': stock.ticker,
            'name': stock.name,
            'currency': stock.currency,
            'quantity': stock.quantity,
            'purchase_price': stock.purchase_price,
            'purchase_date': stock.purchase_date.isoformat() if stock.purchase_date else None,
            'position_entries': normalize_position_entries(
                getattr(stock, 'position_entries', None),
                stock.quantity,
                stock.purchase_price,
                stock.purchase_date,
            ),
        })

    normalized_rates = {
        currency_pair: rates_snapshot[currency_pair]
        for currency_pair in sorted(rates_snapshot)
    }

    normalized_mapping = {
        ticker: mapping_snapshot[ticker]
        for ticker in sorted(mapping_snapshot or {})
    }

    serialized = json.dumps({
        'stocks': normalized_stocks,
        'display_currency': display_currency,
        'current_day': current_day.isoformat(),
        'rates_snapshot': normalized_rates,
        'mapping_snapshot': normalized_mapping,
    }, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()


def parse_event_date(value) -> Optional[date]:
    """
    Parse various date-like inputs into a datetime.date.
    
    Accepts None, datetime.date, datetime.datetime, or a string containing an ISO date or ISO datetime (trailing 'Z' treated as UTC). Leading/trailing whitespace is ignored. For strings, the function first attempts full ISO parsing and, on failure, retries after truncating at a 'T' or the first space. Returns None for unsupported types, empty strings, or unparsable values.
    
    Parameters:
        value: A None, date, datetime, or string to parse.
    
    Returns:
        A datetime.date parsed from the input, or None if parsing fails or the input is invalid.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None

    normalized = value.strip()
    if not normalized:
        return None

    normalized = normalized.replace('Z', '+00:00')

    try:
        return datetime.fromisoformat(normalized).date()
    except ValueError:
        if 'T' in normalized:
            normalized = normalized.split('T', 1)[0]
        elif ' ' in normalized:
            normalized = normalized.split(' ', 1)[0]

        try:
            return datetime.fromisoformat(normalized).date()
        except ValueError:
            return None


def sort_event_date(value) -> date:
    parsed = parse_event_date(value)
    return parsed if parsed is not None else date.max


def _build_upcoming_dividend_identifier(
    ticker: str | None,
    ex_date: str | None,
    payment_date: str | None,
    amount: float | int | None,
    currency: str | None,
    source: str | None,
    dividend_type: str | None,
) -> str:
    return '|'.join([
        ticker or '',
        ex_date or '',
        payment_date or '',
        '' if amount is None else f'{float(amount):.12g}',
        currency or '',
        source or '',
        dividend_type or '',
    ])


@dataclass(frozen=True)
class PositionSnapshot:
    quantity: float
    purchase_price: Optional[float]
    purchase_date: Optional[date]
    position_entries: list[dict]


def apply_position_snapshot(stock: Stock) -> PositionSnapshot:
    position_entries = normalize_position_entries(
        getattr(stock, 'position_entries', None),
        stock.quantity,
        stock.purchase_price,
        stock.purchase_date,
    )
    snapshot = calculate_position_snapshot(position_entries, position_currency=stock.currency)
    return PositionSnapshot(
        quantity=float(snapshot['quantity']),
        purchase_price=snapshot['purchase_price'],
        purchase_date=parse_event_date(snapshot['purchase_date']),
        position_entries=snapshot['position_entries'],
    )


def _normalize_platform_name(value: object) -> str:
    if value is None:
        return "Unassigned"
    normalized = str(value).strip()
    return normalized or "Unassigned"


def _compute_upcoming_portfolio_dividends_result(
    stocks: list[Stock],
    display_currency: str,
    today: date,
    current_year: int,
    cache_key: str,
    cached: dict | None,
    cached_value: dict | None,
    mapping_snapshot: dict[str, dict | None],
    avanza_mappings_by_ticker: dict[str, object | None],
) -> dict:
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service

    stock_service = StockService()
    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    normalized_events_by_ticker: dict[str, list[dict]] = {}
    position_snapshots_by_ticker: dict[str, PositionSnapshot] = {}

    for stock in stocks:
        snapshot = apply_position_snapshot(stock)
        if not has_position_history(snapshot.position_entries, snapshot.quantity):
            normalized_events_by_ticker[stock.ticker] = []
            continue
        position_snapshots_by_ticker[stock.ticker] = snapshot

        avanza_mapping = avanza_mappings_by_ticker.get(stock.ticker)
        if avanza_mapping and getattr(avanza_mapping, 'instrument_id', None):
            avanza_events = avanza_service.get_stock_dividends_for_year(stock.ticker, current_year)
            if avanza_events:
                normalized_events = [{
                    'ex_date': div.ex_date,
                    'payment_date': div.payment_date,
                    'amount': div.amount,
                    'currency': div.currency,
                    'source': 'avanza',
                    'dividend_type': div.dividend_type,
                } for div in avanza_events]
            else:
                normalized_events = get_yahoo_normalized_events(stock_service, stock.ticker)
        else:
            normalized_events = get_yahoo_normalized_events(stock_service, stock.ticker)

        normalized_events = normalized_events or []
        normalized_events_by_ticker[stock.ticker] = normalized_events
        for normalized_event in normalized_events:
            dividend_currency = normalized_event.get('currency') or stock.currency
            if dividend_currency:
                currencies.add(dividend_currency)

    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    cache_fingerprint = _build_upcoming_dividends_cache_fingerprint(
        stocks,
        display_currency,
        today,
        rates,
        mapping_snapshot,
    )
    if cached and cached.get('fingerprint') == cache_fingerprint and isinstance(cached_value, dict):
        return cached_value

    dividends = []
    unmapped_stocks = []
    seen_unmapped = set()

    for stock in stocks:
        snapshot = position_snapshots_by_ticker.get(stock.ticker)
        if snapshot is None:
            continue
        avanza_mapping = avanza_mappings_by_ticker.get(stock.ticker)
        no_avanza_mapping = avanza_mapping is None or not avanza_mapping.instrument_id

        normalized_events = normalized_events_by_ticker.get(stock.ticker, [])
        if not normalized_events:
            continue

        seen_event_keys = set()

        for div in normalized_events:
            ex_date = div.get('ex_date', '')
            payment_date = div.get('payment_date')
            payout_date = payment_date or ex_date
            ex_date_parsed = parse_event_date(ex_date)
            payout_date_parsed = parse_event_date(payout_date)
            if not payout_date_parsed:
                continue

            entitlement_date = ex_date_parsed or payout_date_parsed
            quantity_on_entitlement = get_quantity_held_on_date(snapshot.position_entries, entitlement_date)
            if quantity_on_entitlement <= 0 or payout_date_parsed.year != current_year:
                continue

            event_key = (
                ex_date,
                payment_date,
                div.get('amount'),
                div.get('currency') or stock.currency,
                div.get('dividend_type')
            )
            if event_key in seen_event_keys:
                continue
            seen_event_keys.add(event_key)

            amount = div.get('amount')
            if not amount or amount < 0:
                continue

            total_amount = amount * quantity_on_entitlement
            div_currency = div.get('currency') or stock.currency
            converted_total = convert_value(total_amount, div_currency, display_currency, rates)
            source = div.get('source', 'yahoo')
            status = 'paid' if payout_date_parsed <= today else 'upcoming'
            dividend_id = _build_upcoming_dividend_identifier(
                stock.ticker,
                ex_date,
                payment_date,
                amount,
                div_currency,
                source,
                div.get('dividend_type'),
            )

            if stock.ticker.endswith('.ST') and source == 'yahoo' and no_avanza_mapping and stock.ticker not in seen_unmapped:
                seen_unmapped.add(stock.ticker)
                unmapped_stocks.append({
                    'ticker': stock.ticker,
                    'name': stock.name,
                    'reason': 'no_avanza_mapping'
                })

            dividends.append({
                'id': dividend_id,
                'ticker': stock.ticker,
                'name': stock.name,
                'quantity': quantity_on_entitlement,
                'ex_date': ex_date,
                'payment_date': payment_date,
                'payout_date': payout_date,
                'status': status,
                'dividend_type': div.get('dividend_type'),
                'amount_per_share': amount,
                'total_amount': total_amount,
                'currency': div_currency,
                'total_converted': converted_total,
                'display_currency': display_currency,
                'source': source
            })

    dividends.sort(key=lambda item: (sort_event_date(item.get('payout_date')), sort_event_date(item.get('ex_date'))))

    total_expected = 0
    total_received = 0
    total_remaining = sum(
        d['total_converted']
        for d in dividends
        if d['total_converted'] is not None and d.get('status') == 'upcoming'
    )
    skipped_dividend_ids = []
    totals_partial = any(d.get('total_converted') is None for d in dividends)

    for dividend in dividends:
        converted_total = dividend.get('total_converted')
        if converted_total is None:
            skipped_dividend_ids.append(dividend['id'])
            continue
        total_expected += converted_total
        if dividend.get('status') == 'paid':
            total_received += converted_total

    result = {
        'dividends': dividends,
        'total_expected': total_expected,
        'total_received': total_received,
        'total_remaining': total_remaining,
        'totals_partial': totals_partial,
        'dividends_partial': len(skipped_dividend_ids) > 0,
        'skipped_dividend_count': len(skipped_dividend_ids),
        'skipped_dividend_ids': skipped_dividend_ids,
        'display_currency': display_currency,
        'unmapped_stocks': unmapped_stocks
    }
    _save_json_cache(
        cache_key,
        {
            'fingerprint': cache_fingerprint,
            'value': result,
        },
    )
    return result


def normalize_dividend_event(raw_div: dict, event_type: str) -> dict:
    """
    Normalize a raw dividend event into a standardized dictionary with consistent keys.

    Parameters:
        raw_div (dict): Raw dividend data containing any of 'date' (historical), 'ex_date' (upcoming), 'payment_date', 'amount', 'currency', 'source', and 'dividend_type'.
        event_type (str): Indicates the input shape; use 'historical' when the ex-date is provided under the 'date' key, otherwise the function will read 'ex_date'.

    Returns:
        dict: Normalized dividend event with keys:
            - 'ex_date': ex-dividend date string (from 'date' for historical events or 'ex_date' otherwise).
            - 'payment_date': payment date value from the input or None.
            - 'amount': dividend amount per share from the input or None.
            - 'currency': currency code from the input or None.
            - 'source': data source (defaults to 'yahoo' if not provided).
            - 'dividend_type': dividend classification from the input or None.
    """
    if event_type == 'historical':
        ex_date = raw_div.get('date', '')
    else:
        ex_date = raw_div.get('ex_date', '')

    return {
        'ex_date': ex_date,
        'payment_date': raw_div.get('payment_date'),
        'amount': raw_div.get('amount'),
        'currency': raw_div.get('currency'),
        'source': raw_div.get('source', 'yahoo'),
        'dividend_type': raw_div.get('dividend_type')
    }


def dividend_event_merge_key(event: dict) -> Optional[tuple[str, ...]]:
    """
    Compute a merge key for a dividend event to support deduplication.
    
    Parameters:
        event (dict): Dividend event containing at least an 'ex_date' and optionally a 'dividend_type'.
    
    Returns:
        tuple[str, ...] | None: A key tuple for merging:
          - (ex_date,) if 'dividend_type' is missing,
          - (ex_date, dividend_type) if present,
          - `None` if 'ex_date' is missing.
    """
    ex_date = event.get('ex_date')
    if not ex_date:
        return None

    dividend_type = event.get('dividend_type')
    if not dividend_type:
        return (ex_date,)

    return ex_date, dividend_type


def get_yahoo_normalized_events(stock_service, ticker: str) -> list:
    """
    Create a merged list of normalized dividend events for the given ticker by combining Yahoo historical (last 2 years) and upcoming data.
    
    Historical events are normalized and indexed by their merge key (ex_date and dividend_type); upcoming events are normalized and either used to enrich matching historical entries (filling missing payment_date, currency, or dividend_type) or appended when no match exists.
    
    Returns:
        list: A list of normalized dividend event dictionaries, with historical events enriched by matching upcoming events when available.
    """
    historical = stock_service.get_dividends(ticker, years=2) or []
    upcoming = stock_service.get_upcoming_dividends(ticker) or []

    normalized = [normalize_dividend_event(div, 'historical') for div in historical]

    historical_by_ex_date = {
        merge_key: event
        for event in normalized
        if (merge_key := dividend_event_merge_key(event)) is not None
    }

    for div in upcoming:
        normalized_upcoming = normalize_dividend_event(div, 'upcoming')
        upcoming_key = dividend_event_merge_key(normalized_upcoming)
        historical_event = historical_by_ex_date.get(upcoming_key) if upcoming_key else None
        got_from_wildcard = False
        if historical_event is None and upcoming_key and len(upcoming_key) > 1:
            historical_event = historical_by_ex_date.get((upcoming_key[0],))
            got_from_wildcard = historical_event is not None
        if historical_event is not None:
            if not historical_event.get('payment_date') and normalized_upcoming.get('payment_date'):
                historical_event['payment_date'] = normalized_upcoming.get('payment_date')
            if not historical_event.get('currency') and normalized_upcoming.get('currency'):
                historical_event['currency'] = normalized_upcoming.get('currency')
            if not historical_event.get('dividend_type') and normalized_upcoming.get('dividend_type'):
                historical_event['dividend_type'] = normalized_upcoming.get('dividend_type')
            if upcoming_key:
                historical_by_ex_date[upcoming_key] = historical_event
            fallback_key = dividend_event_merge_key(historical_event)
            if fallback_key:
                historical_by_ex_date[fallback_key] = historical_event
            if got_from_wildcard and upcoming_key:
                historical_by_ex_date.pop((upcoming_key[0],), None)
            continue
        normalized.append(normalized_upcoming)
        if upcoming_key:
            historical_by_ex_date[upcoming_key] = normalized_upcoming

    return normalized

def get_display_currency(db: Session, user_id: int) -> str:
    """
    Return the user's preferred display currency.
    
    Returns:
        display_currency (str): The user's currency code (e.g., "USD", "SEK"). Defaults to "SEK" if the user has no settings.
    """
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if settings:
        return settings.display_currency
    return "SEK"


def convert_value(value: float, from_currency: str, to_currency: str, rates: dict) -> Optional[float]:
    """
    Convert a monetary value from one currency to another using the provided exchange rates.
    
    The `rates` mapping should use keys of the form "SRC_TGT" (e.g., "USD_SEK") with numeric rates. If a direct or inverse rate for the source/target pair exists the function applies it; if not, it may attempt conversion via SEK as an intermediary. If no viable conversion path is available, the function returns None.
    
    Parameters:
        value (float): Amount in the source currency.
        from_currency (str): Source currency ISO code.
        to_currency (str): Target currency ISO code.
        rates (dict): Mapping of exchange rate keys (e.g., {"USD_SEK": 10.5, "SEK_EUR": 0.09}) to numeric rates.
    
    Returns:
        float: Converted amount in the target currency, or `None` if no applicable rate is found.
    """
    if from_currency == to_currency:
        return value
    
    key = f"{from_currency}_{to_currency}"
    if key in rates and rates[key]:
        return value * rates[key]
    
    inverse_key = f"{to_currency}_{from_currency}"
    if inverse_key in rates and rates[inverse_key]:
        return value / rates[inverse_key]

    if from_currency != 'SEK' and to_currency != 'SEK':
        sek_key = f"{from_currency}_SEK"
        target_key = f"SEK_{to_currency}"
        inverse_sek_key = f"SEK_{from_currency}"
        inverse_target_key = f"{to_currency}_SEK"

        if rates.get(sek_key) and rates.get(target_key):
            return value * rates[sek_key] * rates[target_key]
        if rates.get(sek_key) and rates.get(inverse_target_key):
            return value * rates[sek_key] / rates[inverse_target_key]
        if rates.get(inverse_sek_key) and rates.get(target_key):
            return (value / rates[inverse_sek_key]) * rates[target_key]
        if rates.get(inverse_sek_key) and rates.get(inverse_target_key):
            return (value / rates[inverse_sek_key]) / rates[inverse_target_key]

    return None


COUNTRY_BY_TICKER_SUFFIX = {
    '.ST': 'Sweden',
    '.DE': 'Germany',
    '.PA': 'France',
    '.MI': 'Italy',
    '.AS': 'Netherlands',
    '.BR': 'Belgium',
    '.TO': 'Canada',
    '.HK': 'Hong Kong',
    '.AX': 'Australia',
    '.T': 'Japan',
    '.SI': 'Singapore',
    '.L': 'United Kingdom',
    '.SW': 'Switzerland',
    '.HE': 'Finland',
    '.CO': 'Denmark',
    '.OL': 'Norway',
}


def infer_country_from_ticker(ticker: str) -> Optional[str]:
    """
    Infer the country associated with a stock ticker using known suffix mappings and simple heuristics.
    
    Parameters:
        ticker (str): Stock ticker or symbol; may include an exchange suffix (e.g., ".ST", ".DE").
    
    Returns:
        country (Optional[str]): Country name matched from suffix mappings, "United States" when the ticker has no suffix and is non-empty, or `None` if no inference can be made.
    """
    ticker_upper = (ticker or '').upper()
    for suffix, country in COUNTRY_BY_TICKER_SUFFIX.items():
        if ticker_upper.endswith(suffix):
            return country
    if '.' not in ticker_upper and ticker_upper:
        return 'United States'
    return None


@router.get("/summary")
def get_portfolio_summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Compute portfolio totals and per-stock metrics expressed in the current user's display currency.
    
    Returns:
        dict: Summary with keys:
            total_value (float): Sum of all convertible current stock values in display currency.
            total_cost (float): Sum of all convertible cost bases in display currency.
            total_gain_loss (float): Aggregate gain or loss (total_value - total_cost) in display currency.
            total_gain_loss_percent (float): Percentage gain/loss relative to total_cost (0 if total_cost <= 0).
            display_currency (str): Currency code used for all converted display values.
            stocks (list): Per-stock dictionaries containing:
                ticker (str), name (str), quantity (number), current_price (number),
                current_value (number): value in display currency when convertible, otherwise native value,
                currency (str), sector (str), logo (str),
                total_cost (number or None): purchase cost in display currency when convertible, otherwise native value.
                gain_loss (number or None): per-stock gain/loss in display currency when both value and cost convertible,
                gain_loss_percent (number or None): per-stock percent gain when computable,
                current_value_converted (bool): whether current_value is converted to display currency,
                total_cost_converted (bool): whether purchase cost was converted to display currency,
                daily_change (number or None): position daily change in display currency when convertible, otherwise native value,
                daily_change_converted (bool): whether daily_change is converted to display currency.
            stock_count (int): Number of stocks retrieved for the user.
            unconverted_stocks (list): Entries for stocks omitted or partially omitted from totals due to missing exchange rates;
                each entry includes ticker, currency, and reason.
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    stale_logos_cleared = False
    for stock in stocks:
        normalized_logo = brandfetch_service.normalize_stored_logo_url(stock.logo)
        if normalized_logo != stock.logo:
            stock.logo = normalized_logo
            stale_logos_cleared = True

    if stale_logos_cleared:
        db.commit()

    display_currency = get_display_currency(db, current_user.id)

    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    total_value = 0
    total_value_partial = False
    total_cost = 0
    total_cost_partial = False
    total_gain_loss = 0
    total_gain_loss_partial = False
    daily_change = 0
    daily_change_partial = False
    dividend_yield_weighted = 0
    dividend_yield_total_value = 0
    dividend_yield_partial = False
    last_updated: datetime | None = None
    
    stock_data = []
    unconverted_stocks = []
    
    for stock in stocks:
        snapshot = apply_position_snapshot(stock)
        if stock.last_updated and (last_updated is None or stock.last_updated > last_updated):
            last_updated = stock.last_updated

        if stock.current_price is not None and snapshot.quantity is not None and snapshot.quantity > 0:
            current_value_native = stock.current_price * snapshot.quantity
            current_value = convert_value(current_value_native, stock.currency, display_currency, rates)
            display_price = convert_value(stock.current_price, stock.currency, display_currency, rates)
            display_price_converted = display_price is not None
            if display_price is None:
                display_price = stock.current_price

            daily_change_native = (
                (stock.current_price - stock.previous_close) * snapshot.quantity
                if stock.previous_close is not None
                else None
            )
            daily_change_converted = (
                convert_value(daily_change_native, stock.currency, display_currency, rates)
                if daily_change_native is not None
                else None
            )
            stock_cost_native = (
                snapshot.purchase_price * snapshot.quantity
                if snapshot.purchase_price is not None
                else None
            )
            
            if current_value is None:
                total_value_partial = True
                total_cost_partial = True
                total_gain_loss_partial = True
                daily_change_partial = True
                dividend_yield_partial = True
                logger.warning(
                    f"Skipping {stock.ticker} in totals: no conversion rate for "
                    f"{stock.currency} to {display_currency}"
                )
                unconverted_stocks.append({
                    "ticker": stock.ticker,
                    "currency": stock.currency,
                    "reason": "missing_exchange_rate"
                })
                stock_data.append({
                    "ticker": stock.ticker,
                    "name": stock.name,
                    "quantity": snapshot.quantity,
                    "current_price": stock.current_price,
                    "display_price": display_price,
                    "display_price_converted": display_price_converted,
                    "current_value": current_value_native,
                    "currency": stock.currency,
                    "sector": stock.sector,
                    "logo": stock.logo,
                    "total_cost": stock_cost_native,
                    "total_cost_converted": False,
                    "gain_loss": None,
                    "gain_loss_percent": None,
                    "current_value_converted": False,
                    "daily_change": daily_change_native,
                    "daily_change_converted": False,
                })
                continue
            
            total_value += current_value

            if daily_change_native is not None:
                if daily_change_converted is None:
                    daily_change_partial = True
                else:
                    daily_change += daily_change_converted
            else:
                daily_change_partial = True

            if stock.dividend_yield is not None:
                if current_value > 0:
                    dividend_yield_weighted += current_value * stock.dividend_yield
                    dividend_yield_total_value += current_value
                else:
                    dividend_yield_partial = True
            else:
                dividend_yield_partial = True
            
            cost = None
            cost_converted = False
            if stock_cost_native is not None:
                cost = convert_value(stock_cost_native, stock.currency, display_currency, rates)
            if snapshot.purchase_price is not None:
                cost = calculate_position_cost_basis(
                    snapshot.position_entries,
                    stock.currency,
                    display_currency,
                    conversion_callback=lambda amount, from_currency, to_currency: convert_value(amount, from_currency, to_currency, rates),
                    fallback_quantity=stock.quantity,
                    fallback_purchase_price=stock.purchase_price,
                    fallback_purchase_date=stock.purchase_date,
                )
                if cost is None:
                    total_cost_partial = True
                    total_gain_loss_partial = True
                    logger.warning(
                        f"Skipping {stock.ticker} cost in totals: no conversion rate for "
                        f"{stock.currency} to {display_currency}"
                    )
                    unconverted_stocks.append({
                        "ticker": stock.ticker,
                        "currency": stock.currency,
                        "reason": "missing_exchange_rate_for_cost"
                    })
                    gain_loss = None
                else:
                    total_cost += cost
                    gain_loss = current_value - cost
                    total_gain_loss += gain_loss
                    cost_converted = True
            else:
                total_cost_partial = True
                total_gain_loss_partial = True
                gain_loss = None

            gain_loss_percent = None
            if gain_loss is not None and cost_converted and isinstance(cost, (int, float)) and cost > 0:
                gain_loss_percent = gain_loss / cost * 100
            
            stock_data.append({
                "ticker": stock.ticker,
                "name": stock.name,
                "quantity": snapshot.quantity,
                "current_price": stock.current_price,
                "display_price": display_price,
                "display_price_converted": display_price_converted,
                "current_value": current_value,
                "currency": stock.currency,
                "sector": stock.sector,
                "logo": stock.logo,
                "total_cost": cost if cost is not None else stock_cost_native,
                "total_cost_converted": cost_converted,
                "gain_loss": gain_loss,
                "gain_loss_percent": gain_loss_percent,
                "current_value_converted": True,
                "daily_change": daily_change_converted if daily_change_converted is not None else daily_change_native,
                "daily_change_converted": daily_change_converted is not None,
            })
        elif snapshot.quantity is not None and snapshot.quantity > 0:
            total_value_partial = True
            total_cost_partial = True
            total_gain_loss_partial = True
            daily_change_partial = True
            dividend_yield_partial = True
    
    total_gain_loss_percent = (total_gain_loss / total_cost * 100) if total_cost > 0 else 0
    portfolio_dividend_yield = (
        dividend_yield_weighted / dividend_yield_total_value
        if dividend_yield_total_value > 0
        else 0
    )
    
    return {
        "total_value": total_value,
        "total_value_partial": total_value_partial,
        "total_cost": total_cost,
        "total_cost_partial": total_cost_partial,
        "total_gain_loss": total_gain_loss,
        "total_gain_loss_partial": total_gain_loss_partial,
        "total_gain_loss_percent": total_gain_loss_percent,
        "daily_change": daily_change,
        "daily_change_partial": daily_change_partial,
        "dividend_yield": portfolio_dividend_yield,
        "dividend_yield_partial": dividend_yield_partial,
        "last_updated": last_updated,
        "display_currency": display_currency,
        "stocks": stock_data,
        "stock_count": len(stock_data),
        "unconverted_stocks": unconverted_stocks,
    }


@router.post("/refresh-all")
def refresh_all_prices(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Refresh current prices and logos for all portfolio stocks, record daily price history, and update the portfolio's total value.
    
    Fetches price and metadata from external services, upserts per-stock today's price history, converts per-stock values to SEK to compute the portfolio total for the current 15-minute interval, and upserts that total into PortfolioHistory.
    
    Returns:
        dict: Response containing:
            - message (str): Summary, e.g. "Refreshed 5 stocks".
            - skipped (int): Number of stocks skipped due to missing exchange rates.
            - logos_backfilled (int): Number of stocks that received a logo where none existed.
            - logos_refreshed (int): Number of stocks whose logo URL was updated.
            - logos_cleared (int): Number of stale logo references removed because no replacement logo could be persisted.
    """
    from app.services.stock_service import StockService
    from app.services.exchange_rate_service import ExchangeRateService
    stock_service = StockService()
    
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    updated = 0
    total_value_sek = 0
    logos_backfilled = 0
    logos_refreshed = 0
    logos_cleared = 0
    
    currencies = {s.currency for s in stocks if s.currency}
    rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")
    
    skipped = 0
    request_ts = utc_now()
    today = request_ts.replace(hour=0, minute=0, second=0, microsecond=0)
    for stock in stocks:
        snapshot = apply_position_snapshot(stock)
        info = stock_service.get_stock_info(stock.ticker)
        if info:
            stock.current_price = info.get('current_price')
            stock.previous_close = info.get('previous_close')
            stock.sector = info.get('sector') or stock.sector
            stock.dividend_yield = info.get('dividend_yield')
            stock.dividend_per_share = info.get('dividend_per_share')
            stock.last_updated = request_ts
            updated += 1

        original_logo = stock.logo
        logo_url = brandfetch_service.get_logo_url_for_ticker(
            stock.ticker,
            stock.name,
            force_refresh=False,
            existing_logo=stock.logo,
        )
        if logo_url and logo_url != stock.logo:
            if not stock.logo:
                logos_backfilled += 1
            else:
                logos_refreshed += 1
            stock.logo = logo_url
        elif original_logo and brandfetch_service.should_refresh_logo(original_logo):
            stock.logo = None
            logos_cleared += 1
        
        if stock.current_price is not None:
            price_stmt = insert(StockPriceHistory).values(
                user_id=current_user.id,
                ticker=stock.ticker,
                price=stock.current_price,
                currency=stock.currency,
                recorded_at=today,
            )
            price_stmt = price_stmt.on_conflict_do_update(
                index_elements=[
                    StockPriceHistory.user_id,
                    StockPriceHistory.ticker,
                    StockPriceHistory.recorded_at,
                ],
                set_={
                    "price": price_stmt.excluded.price,
                    "currency": price_stmt.excluded.currency,
                },
            )
            db.execute(price_stmt)
        
        if stock.current_price is not None and snapshot.quantity is not None and snapshot.quantity > 0:
            value = stock.current_price * snapshot.quantity
            converted_value = convert_value(value, stock.currency, 'SEK', rates)
            if converted_value is not None:
                total_value_sek += converted_value
            else:
                logger.warning(
                    f"Skipping {stock.ticker}: no conversion rate for "
                    f"{stock.currency} to SEK"
                )
                skipped += 1
    
    if skipped > 0:
        logger.warning(
            f"Portfolio history includes partial FX data: skipped {skipped} stock(s) due to missing conversion rates"
        )

    if updated > 0 and total_value_sek > 0:
        interval = request_ts.replace(minute=(request_ts.minute // 15) * 15, second=0, microsecond=0)
        stmt = insert(PortfolioHistory).values(
            user_id=current_user.id,
            date=interval,
            total_value=total_value_sek,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[PortfolioHistory.user_id, PortfolioHistory.date],
            set_={"total_value": stmt.excluded.total_value},
        )
        db.execute(stmt)
    
    db.commit()
    
    return {
        "message": f"Refreshed {updated} stocks",
        "skipped": skipped,
        "logos_backfilled": logos_backfilled,
        "logos_refreshed": logos_refreshed,
        "logos_cleared": logos_cleared,
    }


@router.get("/history", response_model=List[dict])
def get_portfolio_history(
    days: int = Query(30, ge=1),
    range_key: Optional[str] = Query(None, alias="range"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return portfolio total-value snapshots for a requested historical range.
    
    Parameters:
        days (int): Fallback number of days to include when `range_key` is not provided; will be coerced to an integer between 1 and 3650.
        range_key (Optional[str]): Optional predefined range; supported values: "1d", "1w", "1m", "ytd", "1y", "since_start", "all". If provided, it takes precedence over `days`.
        
    Returns:
        List[dict]: Ordered list of records with keys `date` (timestamp) and `value` (total portfolio value) sorted ascending by date.
    """
    from datetime import timedelta
    
    now = utc_now()
    since = None
    normalized_range = (range_key or "").strip().lower()

    if normalized_range == "1d":
        since = now - timedelta(days=1)
    elif normalized_range == "1w":
        since = now - timedelta(days=7)
    elif normalized_range == "1m":
        since = now - timedelta(days=30)
    elif normalized_range == "ytd":
        since = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    elif normalized_range == "1y":
        since = now - timedelta(days=365)
    elif normalized_range in {"since_start", "all"}:
        since = None
    else:
        days = max(1, min(days, 3650))
        since = now - timedelta(days=days)

    query = db.query(PortfolioHistory).filter(PortfolioHistory.user_id == current_user.id)
    if since is not None:
        query = query.filter(PortfolioHistory.date >= since)

    history = query.order_by(PortfolioHistory.date.asc()).all()
    return [{"date": h.date, "value": h.total_value} for h in history]


@router.get("/distribution")
def get_portfolio_distribution(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Compute the portfolio's value distribution aggregated by sector, country, currency, and ticker, expressed using the user's display currency.

    Stocks use current market price when available and fall back to purchase price so holdings are still represented in analytics when a live quote is temporarily missing.
    
    Returns:
        dict: A mapping with keys:
            - display_currency (str): The user's display currency code.
            - by_sector (dict): sector name -> total market value for that sector (converted to display currency).
            - by_country (dict): country name -> total market value for that country (converted to display currency).
            - by_currency (dict): currency code -> total market value in that native currency (not converted).
            - by_stock (dict): ticker -> total market value for that stock (converted to display currency).
    """
    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    display_currency = get_display_currency(db, current_user.id)
    currencies = {stock.currency for stock in stocks if stock.currency}
    currencies.add('SEK')
    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    
    by_sector = {}
    by_country = {}
    by_currency = {}
    by_stock = {}
    by_platform = {}
    
    for stock in stocks:
        snapshot = apply_position_snapshot(stock)
        if not has_position_history(snapshot.position_entries, snapshot.quantity):
            continue
        if snapshot.quantity is None or snapshot.quantity <= 0:
            continue

        unit_price = stock.current_price if stock.current_price is not None else snapshot.purchase_price
        if unit_price is None:
            continue

        value_native = unit_price * snapshot.quantity
        by_currency[stock.currency] = by_currency.get(stock.currency, 0) + value_native
        value = convert_value(value_native, stock.currency, display_currency, rates)
        if value is None:
            continue

        sector = stock.sector or "Unknown"
        by_sector[sector] = by_sector.get(sector, 0) + value

        country = infer_country_from_ticker(stock.ticker) or "Unknown"
        by_country[country] = by_country.get(country, 0) + value

        by_stock[stock.ticker] = by_stock.get(stock.ticker, 0) + value

        for entry in snapshot.position_entries:
            if entry.get('sell_date'):
                continue
            entry_quantity = entry.get('quantity')
            if not isinstance(entry_quantity, (int, float)) or entry_quantity <= 0:
                continue

            entry_unit_price = stock.current_price if stock.current_price is not None else entry.get('purchase_price')
            if entry_unit_price is None:
                continue

            entry_value_native = entry_unit_price * float(entry_quantity)
            entry_value = convert_value(entry_value_native, stock.currency, display_currency, rates)
            if entry_value is None:
                continue

            platform_name = _normalize_platform_name(entry.get('platform'))
            by_platform[platform_name] = by_platform.get(platform_name, 0) + entry_value
    
    return {
        "display_currency": display_currency,
        "by_sector": by_sector,
        "by_country": by_country,
        "by_currency": by_currency,
        "by_stock": by_stock,
        "by_platform": by_platform,
    }


@router.get("/upcoming-dividends")
def get_upcoming_portfolio_dividends(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Collect current-year dividend events for the current user's holdings, filter to entitlements, deduplicate and normalize events from Avanza or Yahoo, convert per-stock totals to the user's display currency, and return aggregated totals.
    
    Searches Avanza first when an instrument mapping exists, falls back to Yahoo otherwise; excludes events where the user did not hold the position on the entitlement date, marks events as 'paid' or 'upcoming' based on payout date, and may return a cached result keyed to a fingerprint of the user's portfolio state.
    
    Returns:
        dict: {
            'dividends': list of dict — Each item contains:
                - 'ticker' (str)
                - 'name' (str)
                - 'quantity' (number) — quantity held on the entitlement date
                - 'ex_date' (str or None)
                - 'payment_date' (str or None)
                - 'payout_date' (str) — chosen payment_date or ex_date
                - 'status' (str) — 'paid' or 'upcoming'
                - 'dividend_type' (str or None)
                - 'amount_per_share' (number)
                - 'total_amount' (number) — amount_per_share * quantity
                - 'currency' (str) — dividend currency used for total_amount
                - 'total_converted' (float or None) — total_amount converted to the user's display currency, or None if conversion unavailable
                - 'display_currency' (str)
                - 'source' (str) — data source identifier, e.g. 'avanza' or 'yahoo'
            'total_expected' (float): Sum of `total_converted` for all listed dividends where conversion succeeded.
            'total_received' (float): Sum of `total_converted` for dividends with status == 'paid'.
            'total_remaining' (float): Sum of `total_converted` for dividends with status == 'upcoming'.
            'dividends_partial' (bool): Whether one or more listed dividends were excluded from aggregate totals.
            'skipped_dividend_count' (int): Number of listed dividends excluded from aggregate totals.
            'skipped_dividend_ids' (list[str]): Identifiers of dividends excluded from aggregate totals.
            'display_currency' (str): The user's display currency used for conversions.
            'unmapped_stocks' (list): List of dicts { 'ticker': str, 'name': str, 'reason': str } for securities lacking an Avanza mapping that were observed.
        }
    """
    from app.services.stock_service import StockService
    from app.services.avanza_service import avanza_service

    stocks = db.query(Stock).filter(Stock.user_id == current_user.id).all()
    display_currency = get_display_currency(db, current_user.id)
    now = utc_now()
    today = now.date()
    current_year = now.year
    cache_key = _portfolio_upcoming_dividends_cache_key(current_user.id)
    cached = _load_json_cache(
        cache_key,
        PORTFOLIO_UPCOMING_DIVIDENDS_CACHE_TTL,
    )
    cached_value = cached.get('value') if isinstance(cached, dict) else None

    avanza_mappings_by_ticker: dict[str, object | None] = {}
    mapping_snapshot: dict[str, dict | None] = {}
    for stock in stocks:
        avanza_mapping = avanza_service.get_mapping_by_ticker(stock.ticker)
        avanza_mappings_by_ticker[stock.ticker] = avanza_mapping
        mapping_snapshot[stock.ticker] = (
            {
                'avanza_name': avanza_mapping.avanza_name,
                'instrument_id': avanza_mapping.instrument_id,
                'manually_added': avanza_mapping.manually_added,
                'added_at': avanza_mapping.added_at,
                'source': 'avanza' if avanza_mapping.instrument_id else 'yahoo',
            }
            if avanza_mapping is not None
            else None
        )

    currencies = {s.currency for s in stocks if s.currency}
    currencies.add('SEK')
    if isinstance(cached_value, dict):
        for cached_dividend in cached_value.get('dividends', []):
            if not isinstance(cached_dividend, dict):
                continue
            dividend_currency = cached_dividend.get('currency')
            if dividend_currency:
                currencies.add(dividend_currency)

    rates = ExchangeRateService.get_rates_for_currencies(currencies, display_currency)
    cache_fingerprint = _build_upcoming_dividends_cache_fingerprint(
        stocks,
        display_currency,
        today,
        rates,
        mapping_snapshot,
    )
    if cached and cached.get('fingerprint') == cache_fingerprint:
        if isinstance(cached_value, dict):
            return cached_value

    inflight_event, is_leader = _begin_portfolio_upcoming_dividends_refresh(current_user.id)
    if not is_leader:
        inflight_event.wait(timeout=PORTFOLIO_UPCOMING_DIVIDENDS_WAIT_TIMEOUT)
        cached = _load_json_cache(
            cache_key,
            PORTFOLIO_UPCOMING_DIVIDENDS_CACHE_TTL,
        )
        cached_value = cached.get('value') if isinstance(cached, dict) else None
        if cached and cached.get('fingerprint') == cache_fingerprint and isinstance(cached_value, dict):
            return cached_value

    try:
        return _compute_upcoming_portfolio_dividends_result(
            stocks=stocks,
            display_currency=display_currency,
            today=today,
            current_year=current_year,
            cache_key=cache_key,
            cached=cached,
            cached_value=cached_value if isinstance(cached_value, dict) else None,
            mapping_snapshot=mapping_snapshot,
            avanza_mappings_by_ticker=avanza_mappings_by_ticker,
        )
    finally:
        if is_leader:
            _finish_portfolio_upcoming_dividends_refresh(current_user.id, inflight_event)
