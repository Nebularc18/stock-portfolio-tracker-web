from __future__ import annotations

from datetime import date, datetime
import math
import logging
from typing import Any, Callable, Optional
import uuid

logger = logging.getLogger(__name__)


def _parse_optional_float(value: Any) -> Optional[float]:
    if value in (None, ''):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _normalize_exchange_rate_currency(value: Any) -> Optional[str]:
    if value in (None, ''):
        return None
    normalized = str(value).strip().upper()
    if len(normalized) != 3 or not normalized.isalpha():
        return None
    return normalized


def _resolve_courtage_currency(entry: dict[str, Any]) -> Optional[str]:
    normalized = _normalize_exchange_rate_currency(entry.get('courtage_currency'))
    return normalized


def parse_position_date(value: Any) -> Optional[date]:
    if value in (None, ''):
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            try:
                return datetime.fromisoformat(value).date()
            except ValueError:
                return None
    return None


def normalize_position_entries(
    entries: Any,
    fallback_quantity: Optional[float] = None,
    fallback_purchase_price: Optional[float] = None,
    fallback_purchase_date: Any = None,
    fallback_courtage: Optional[float] = None,
) -> list[dict[str, Any]]:
    """Normalize lot entries and synthesize a fallback open lot when needed.

    This function may mutate input entry dicts by assigning `entry['id']` when
    an entry is missing an ID so repeated normalization returns a stable ID.
    Callers that require immutability should pass copies before calling.
    """
    normalized: list[dict[str, Any]] = []

    raw_entries = entries if isinstance(entries, list) else []
    for index, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            continue

        quantity_raw = entry.get('quantity')
        try:
            quantity = float(quantity_raw)
        except (TypeError, ValueError):
            continue
        if quantity <= 0:
            continue

        purchase_price_raw = entry.get('purchase_price')
        try:
            purchase_price = None if purchase_price_raw in (None, '') else float(purchase_price_raw)
        except (TypeError, ValueError):
            purchase_price = None

        courtage_raw = entry.get('courtage', 0)
        try:
            courtage = 0.0 if courtage_raw in (None, '') else float(courtage_raw)
        except (TypeError, ValueError):
            courtage = 0.0
        if courtage < 0:
            courtage = 0.0
        courtage_currency = _resolve_courtage_currency(entry)

        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))
        exchange_rate = _parse_optional_float(entry.get('exchange_rate'))
        exchange_rate_currency = _normalize_exchange_rate_currency(entry.get('exchange_rate_currency'))
        if exchange_rate is None:
            exchange_rate_currency = None
        entry_id = entry.get('id')
        if not entry_id:
            entry_id = str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                "|".join([
                    "position-entry",
                    str(index),
                    str(quantity),
                    str(purchase_price),
                    str(courtage),
                    courtage_currency or "",
                    purchase_date.isoformat() if purchase_date else "",
                    sell_date.isoformat() if sell_date else "",
                    str(exchange_rate),
                    exchange_rate_currency or "",
                ]),
            ))
            entry['id'] = entry_id

        normalized.append({
            'id': str(entry_id),
            'quantity': quantity,
            'purchase_price': purchase_price,
            'courtage': courtage,
            'courtage_currency': courtage_currency,
            'purchase_date': purchase_date.isoformat() if purchase_date else None,
            'sell_date': sell_date.isoformat() if sell_date else None,
            'exchange_rate': exchange_rate,
            'exchange_rate_currency': exchange_rate_currency,
        })

    if normalized:
        normalized.sort(key=lambda item: (item.get('purchase_date') or '9999-12-31', item.get('sell_date') or '9999-12-31', item['id']))
        return normalized

    try:
        fallback_qty = float(fallback_quantity) if fallback_quantity is not None else 0.0
    except (TypeError, ValueError):
        fallback_qty = 0.0

    if fallback_qty > 0:
        fallback_date = parse_position_date(fallback_purchase_date)
        try:
            fallback_fee = 0.0 if fallback_courtage in (None, '') else float(fallback_courtage)
        except (TypeError, ValueError):
            fallback_fee = 0.0
        if fallback_fee < 0:
            fallback_fee = 0.0
        return [{
            'id': str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                "|".join([
                    "fallback-position-entry",
                    str(fallback_qty),
                    str(fallback_purchase_price),
                    str(fallback_fee),
                    fallback_date.isoformat() if fallback_date else "",
                ]),
            )),
            'quantity': fallback_qty,
            'purchase_price': fallback_purchase_price,
            'courtage': fallback_fee,
            'courtage_currency': None,
            'purchase_date': fallback_date.isoformat() if fallback_date else None,
            'sell_date': None,
            'exchange_rate': None,
            'exchange_rate_currency': None,
        }]

    return []


def validate_position_entries(entries: Any) -> list[dict[str, Any]]:
    if not isinstance(entries, list):
        raise ValueError('position_entries must be a list')

    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('each position entry must be an object')

        for required_key in ('quantity', 'purchase_price', 'purchase_date'):
            if required_key not in entry:
                raise ValueError(f'position entry missing required field: {required_key}')

        quantity_raw = entry.get('quantity')
        try:
            quantity = float(quantity_raw)
        except (TypeError, ValueError):
            raise ValueError('quantity must be a number') from None
        if quantity <= 0:
            raise ValueError('quantity must be greater than zero')

        purchase_price_raw = entry.get('purchase_price')
        purchase_price = None
        if purchase_price_raw not in (None, ''):
            try:
                purchase_price = float(purchase_price_raw)
            except (TypeError, ValueError):
                raise ValueError('purchase_price must be a number') from None
            if purchase_price < 0:
                raise ValueError('purchase_price must be greater than or equal to zero')

        courtage_raw = entry.get('courtage', 0)
        if courtage_raw not in (None, ''):
            try:
                courtage = float(courtage_raw)
            except (TypeError, ValueError):
                raise ValueError('courtage must be a number') from None
            if courtage < 0:
                raise ValueError('courtage must be greater than or equal to zero')
            if purchase_price is None and courtage > 0:
                raise ValueError('courtage requires purchase_price')

        courtage_currency = entry.get('courtage_currency')
        if courtage_currency not in (None, ''):
            normalized_currency = str(courtage_currency).strip().upper()
            if len(normalized_currency) != 3 or not normalized_currency.isalpha():
                raise ValueError('courtage_currency must be a 3-letter currency code')

        exchange_rate_raw = entry.get('exchange_rate')
        exchange_rate = None
        if exchange_rate_raw not in (None, ''):
            try:
                exchange_rate = float(exchange_rate_raw)
            except (TypeError, ValueError):
                raise ValueError('exchange_rate must be a number') from None
            if not math.isfinite(exchange_rate) or exchange_rate <= 0:
                raise ValueError('exchange_rate must be greater than zero')

        exchange_rate_currency = entry.get('exchange_rate_currency')
        if exchange_rate_currency not in (None, ''):
            normalized_currency = str(exchange_rate_currency).strip().upper()
            if len(normalized_currency) != 3 or not normalized_currency.isalpha():
                raise ValueError('exchange_rate_currency must be a 3-letter currency code')
        elif exchange_rate is not None:
            raise ValueError('exchange_rate requires exchange_rate_currency')

        if exchange_rate is None and exchange_rate_currency not in (None, ''):
            raise ValueError('exchange_rate_currency requires exchange_rate')

        purchase_date_raw = entry.get('purchase_date')
        if purchase_date_raw not in (None, '') and parse_position_date(purchase_date_raw) is None:
            raise ValueError('purchase_date must be a valid date')

        sell_date_raw = entry.get('sell_date')
        if sell_date_raw not in (None, '') and parse_position_date(sell_date_raw) is None:
            raise ValueError('sell_date must be a valid date')

    normalized = normalize_position_entries(entries)

    for entry in normalized:
        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))
        if sell_date and purchase_date and sell_date < purchase_date:
            raise ValueError('sell date cannot be earlier than purchase date')

    return normalized


def calculate_position_snapshot(
    entries: Any,
    position_currency: Optional[str] = None,
    conversion_callback: Optional[Callable[[float, str, str], Optional[float]]] = None,
) -> dict[str, Any]:
    normalized = normalize_position_entries(entries)
    open_entries = [entry for entry in normalized if not entry.get('sell_date')]
    quantity = sum(float(entry['quantity']) for entry in open_entries)

    total_cost = 0.0
    total_quantity_for_cost = 0.0
    purchase_dates: list[str] = []

    for entry in open_entries:
        purchase_dates.append(entry.get('purchase_date') or '')
        purchase_price = entry.get('purchase_price')
        courtage = entry.get('courtage') or 0.0
        courtage_currency = _resolve_courtage_currency(entry)
        if purchase_price is None:
            continue

        native_courtage = float(courtage)
        exchange_rate = entry.get('exchange_rate')
        exchange_rate_currency = entry.get('exchange_rate_currency')
        if native_courtage and courtage_currency:
            converted_courtage = native_courtage if position_currency and courtage_currency == position_currency else None
            if converted_courtage is None and exchange_rate is not None and courtage_currency == exchange_rate_currency:
                converted_courtage = native_courtage / float(exchange_rate)
            elif converted_courtage is None and conversion_callback is not None and position_currency:
                converted_courtage = conversion_callback(native_courtage, courtage_currency, position_currency)

            if converted_courtage is not None:
                native_courtage = float(converted_courtage)
            else:
                logger.warning(
                    "Unable to convert courtage for position snapshot; using original amount courtage=%s courtage_currency=%s position_currency=%s exchange_rate_currency=%s",
                    native_courtage,
                    courtage_currency,
                    position_currency,
                    exchange_rate_currency,
                )

        total_cost += float(purchase_price) * float(entry['quantity']) + native_courtage
        total_quantity_for_cost += float(entry['quantity'])

    return {
        'quantity': quantity,
        'purchase_price': (total_cost / total_quantity_for_cost) if total_quantity_for_cost > 0 else None,
        'purchase_date': min((value for value in purchase_dates if value), default=None),
        'position_entries': normalized,
    }


def calculate_position_cost_basis(
    entries: Any,
    position_currency: str,
    target_currency: str,
    conversion_callback: Optional[Callable[[float, str, str], Optional[float]]] = None,
    fallback_quantity: Optional[float] = None,
    fallback_purchase_price: Optional[float] = None,
    fallback_purchase_date: Any = None,
    fallback_courtage: Optional[float] = None,
) -> Optional[float]:
    normalized = normalize_position_entries(
        entries,
        fallback_quantity=fallback_quantity,
        fallback_purchase_price=fallback_purchase_price,
        fallback_purchase_date=fallback_purchase_date,
        fallback_courtage=fallback_courtage,
    )
    open_entries = [entry for entry in normalized if not entry.get('sell_date')]

    total_cost = 0.0
    has_cost_basis = False
    for entry in open_entries:
        purchase_price = entry.get('purchase_price')
        if purchase_price is None:
            continue

        trade_cost_native = float(purchase_price) * float(entry['quantity'])
        if position_currency == target_currency:
            converted_trade_cost = trade_cost_native
        elif entry.get('exchange_rate') is not None and entry.get('exchange_rate_currency') == target_currency:
            converted_trade_cost = trade_cost_native * float(entry['exchange_rate'])
        elif conversion_callback is not None:
            converted_trade_cost = conversion_callback(trade_cost_native, position_currency, target_currency)
        else:
            return None

        if converted_trade_cost is None:
            return None

        courtage_amount = float(entry.get('courtage') or 0.0)
        courtage_currency = _resolve_courtage_currency(entry) or position_currency
        if courtage_amount == 0:
            converted_courtage = 0.0
        elif courtage_currency == target_currency:
            converted_courtage = courtage_amount
        elif courtage_currency == position_currency:
            if position_currency == target_currency:
                converted_courtage = courtage_amount
            elif entry.get('exchange_rate') is not None and entry.get('exchange_rate_currency') == target_currency:
                converted_courtage = courtage_amount * float(entry['exchange_rate'])
            elif conversion_callback is not None:
                converted_courtage = conversion_callback(courtage_amount, position_currency, target_currency)
            else:
                return None
        elif conversion_callback is not None:
            converted_courtage = conversion_callback(courtage_amount, courtage_currency, target_currency)
        else:
            return None

        if converted_courtage is None:
            return None

        total_cost += float(converted_trade_cost) + float(converted_courtage)
        has_cost_basis = True

    return total_cost if has_cost_basis else None


def get_quantity_held_on_date(
    entries: Any,
    target_date: Any,
    fallback_quantity: Optional[float] = None,
    fallback_purchase_price: Optional[float] = None,
    fallback_purchase_date: Any = None,
    fallback_courtage: Optional[float] = None,
) -> float:
    """Return quantity owned strictly before `resolved_target_date`.

    Entries bought on `resolved_target_date` (`purchase_date >= resolved_target_date`)
    are excluded deliberately to preserve ex-date entitlement semantics. Entries
    sold on `resolved_target_date` remain included.
    """
    normalized = normalize_position_entries(
        entries,
        fallback_quantity=fallback_quantity,
        fallback_purchase_price=fallback_purchase_price,
        fallback_purchase_date=fallback_purchase_date,
        fallback_courtage=fallback_courtage,
    )
    resolved_target_date = parse_position_date(target_date)
    if resolved_target_date is None:
        return sum(float(entry['quantity']) for entry in normalized if not entry.get('sell_date'))

    quantity = 0.0
    for entry in normalized:
        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))

        # Boundary dates are exclusive for purchases but inclusive for same-day
        # sells so ex-date lookups still count positions sold on the target date.
        if purchase_date and purchase_date >= resolved_target_date:
            continue
        if sell_date and sell_date < resolved_target_date:
            continue
        quantity += float(entry['quantity'])

    return quantity


def has_position_history(entries: Any, fallback_quantity: Optional[float] = None) -> bool:
    normalized = normalize_position_entries(entries, fallback_quantity=fallback_quantity)
    return bool(normalized)
