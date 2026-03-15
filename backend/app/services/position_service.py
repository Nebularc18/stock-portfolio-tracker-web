from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional
import uuid


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
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []

    raw_entries = entries if isinstance(entries, list) else []
    for entry in raw_entries:
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

        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))

        normalized.append({
            'id': str(entry.get('id') or uuid.uuid4()),
            'quantity': quantity,
            'purchase_price': purchase_price,
            'purchase_date': purchase_date.isoformat() if purchase_date else None,
            'sell_date': sell_date.isoformat() if sell_date else None,
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
        return [{
            'id': str(uuid.uuid4()),
            'quantity': fallback_qty,
            'purchase_price': fallback_purchase_price,
            'purchase_date': fallback_date.isoformat() if fallback_date else None,
            'sell_date': None,
        }]

    return []


def validate_position_entries(entries: Any) -> list[dict[str, Any]]:
    normalized = normalize_position_entries(entries)
    if not isinstance(entries, list):
        raise ValueError('position_entries must be a list')

    for entry in normalized:
        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))
        if sell_date and purchase_date and sell_date < purchase_date:
            raise ValueError('sell date cannot be earlier than purchase date')

    return normalized


def calculate_position_snapshot(entries: Any) -> dict[str, Any]:
    normalized = normalize_position_entries(entries)
    open_entries = [entry for entry in normalized if not entry.get('sell_date')]
    quantity = sum(float(entry['quantity']) for entry in open_entries)

    total_cost = 0.0
    total_quantity_for_cost = 0.0
    purchase_dates: list[str] = []

    for entry in open_entries:
        purchase_dates.append(entry.get('purchase_date') or '')
        purchase_price = entry.get('purchase_price')
        if purchase_price is None:
            continue
        total_cost += float(purchase_price) * float(entry['quantity'])
        total_quantity_for_cost += float(entry['quantity'])

    return {
        'quantity': quantity,
        'purchase_price': (total_cost / total_quantity_for_cost) if total_quantity_for_cost > 0 else None,
        'purchase_date': min((value for value in purchase_dates if value), default=None),
        'position_entries': normalized,
    }


def get_quantity_held_on_date(entries: Any, target_date: Any) -> float:
    normalized = normalize_position_entries(entries)
    resolved_target_date = parse_position_date(target_date)
    if resolved_target_date is None:
        return sum(float(entry['quantity']) for entry in normalized if not entry.get('sell_date'))

    quantity = 0.0
    for entry in normalized:
        purchase_date = parse_position_date(entry.get('purchase_date'))
        sell_date = parse_position_date(entry.get('sell_date'))

        if purchase_date and purchase_date >= resolved_target_date:
            continue
        if sell_date and sell_date <= resolved_target_date:
            continue
        quantity += float(entry['quantity'])

    return quantity


def has_position_history(entries: Any, fallback_quantity: Optional[float] = None) -> bool:
    normalized = normalize_position_entries(entries, fallback_quantity=fallback_quantity)
    return bool(normalized)
