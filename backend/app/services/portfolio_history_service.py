from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.services.exchange_rate_service import ExchangeRateService
from app.services.position_service import get_quantity_held_on_date, has_position_history, normalize_position_entries


def _normalize_history_timestamp(value: datetime | date) -> datetime:
    if isinstance(value, datetime):
        normalized = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return normalized.replace(hour=0, minute=0, second=0, microsecond=0)
    return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)


def _convert_value(value: float, from_currency: str, to_currency: str, rates: dict[str, float | None]) -> Optional[float]:
    if from_currency == to_currency:
        return value

    key = f"{from_currency}_{to_currency}"
    direct_rate = rates.get(key)
    if direct_rate:
        return value * direct_rate

    inverse_key = f"{to_currency}_{from_currency}"
    inverse_rate = rates.get(inverse_key)
    if inverse_rate:
        return value / inverse_rate

    if from_currency != "SEK" and to_currency != "SEK":
        sek_value = _convert_value(value, from_currency, "SEK", rates)
        if sek_value is None:
            return None
        return _convert_value(sek_value, "SEK", to_currency, rates)

    return None


def collect_missing_portfolio_history_rows(
    stocks: Sequence[Any],
    price_rows: Sequence[Any],
    existing_history_rows: Sequence[Any],
    rates: dict[str, float | None],
    *,
    start_date: Optional[date] = None,
) -> list[dict[str, Any]]:
    rows_by_ticker: dict[str, list[Any]] = defaultdict(list)
    snapshot_days: set[datetime] = set()

    for row in price_rows:
        ticker = str(getattr(row, "ticker", "") or "").upper()
        recorded_at = getattr(row, "recorded_at", None)
        if not ticker or recorded_at is None:
            continue
        normalized_day = _normalize_history_timestamp(recorded_at)
        rows_by_ticker[ticker].append(row)
        if start_date is None or normalized_day.date() >= start_date:
            snapshot_days.add(normalized_day)

    if not snapshot_days:
        return []

    tracked_stocks: list[dict[str, Any]] = []
    for stock in stocks:
        ticker = str(getattr(stock, "ticker", "") or "").upper()
        if not ticker:
            continue
        position_entries = normalize_position_entries(
            getattr(stock, "position_entries", None),
            getattr(stock, "quantity", None),
            getattr(stock, "purchase_price", None),
            getattr(stock, "purchase_date", None),
        )
        fallback_quantity = getattr(stock, "quantity", None)
        if not has_position_history(position_entries, fallback_quantity):
            continue
        tracked_stocks.append({
            "ticker": ticker,
            "currency": str(getattr(stock, "currency", "") or "").upper(),
            "position_entries": position_entries,
            "price_rows": sorted(
                rows_by_ticker.get(ticker, []),
                key=lambda row: _normalize_history_timestamp(getattr(row, "recorded_at")),
            ),
        })

    if not tracked_stocks:
        return []

    existing_history_days = {
        _normalize_history_timestamp(getattr(row, "date")).date()
        for row in existing_history_rows
        if getattr(row, "date", None) is not None
    }

    missing_rows: list[dict[str, Any]] = []
    sorted_snapshot_days = sorted(snapshot_days)
    price_indexes = [0] * len(tracked_stocks)
    latest_rows: list[Any | None] = [None] * len(tracked_stocks)

    for snapshot_day in sorted_snapshot_days:
        if snapshot_day.date() in existing_history_days:
            continue

        total_value_sek = 0.0
        included_positions = 0

        for stock_index, stock_data in enumerate(tracked_stocks):
            stock_price_rows = stock_data["price_rows"]
            while price_indexes[stock_index] < len(stock_price_rows):
                candidate = stock_price_rows[price_indexes[stock_index]]
                candidate_day = _normalize_history_timestamp(getattr(candidate, "recorded_at"))
                if candidate_day > snapshot_day:
                    break
                latest_rows[stock_index] = candidate
                price_indexes[stock_index] += 1

            latest_row = latest_rows[stock_index]
            if latest_row is None:
                continue

            # Position helper uses an exclusive purchase-date boundary, so use the
            # next day to evaluate end-of-day holdings for this snapshot date.
            quantity = get_quantity_held_on_date(
                stock_data["position_entries"],
                snapshot_day.date() + timedelta(days=1),
            )
            if quantity <= 0:
                continue

            price = getattr(latest_row, "price", None)
            if price is None:
                continue

            price_currency = str(getattr(latest_row, "currency", "") or stock_data["currency"]).upper()
            if not price_currency:
                continue

            converted_value = _convert_value(float(price) * float(quantity), price_currency, "SEK", rates)
            if converted_value is None:
                continue

            total_value_sek += converted_value
            included_positions += 1

        if included_positions == 0:
            continue

        missing_rows.append({
            "date": snapshot_day,
            "total_value": total_value_sek,
        })

    return missing_rows


def backfill_portfolio_history_from_prices(
    db: Session,
    user_id: int,
    *,
    start_date: Optional[date] = None,
) -> int:
    from app.main import PortfolioHistory, Stock, StockPriceHistory

    stocks = db.query(Stock).filter(Stock.user_id == user_id).all()
    tickers = [str(getattr(stock, "ticker", "") or "").upper() for stock in stocks if getattr(stock, "ticker", None)]
    if not tickers:
        return 0

    price_rows = db.query(StockPriceHistory).filter(
        StockPriceHistory.user_id == user_id,
        StockPriceHistory.ticker.in_(tickers),
    ).order_by(StockPriceHistory.ticker.asc(), StockPriceHistory.recorded_at.asc()).all()
    if not price_rows:
        return 0

    existing_history_query = db.query(PortfolioHistory).filter(PortfolioHistory.user_id == user_id)
    if start_date is not None:
        existing_history_query = existing_history_query.filter(
            PortfolioHistory.date >= datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc),
        )
    existing_history_rows = existing_history_query.all()

    currencies = {"SEK"}
    currencies.update(
        str(getattr(stock, "currency", "") or "").upper()
        for stock in stocks
        if getattr(stock, "currency", None)
    )
    currencies.update(
        str(getattr(row, "currency", "") or "").upper()
        for row in price_rows
        if getattr(row, "currency", None)
    )
    rates = ExchangeRateService.get_rates_for_currencies(currencies, "SEK")

    rows_to_upsert = collect_missing_portfolio_history_rows(
        stocks,
        price_rows,
        existing_history_rows,
        rates,
        start_date=start_date,
    )
    if not rows_to_upsert:
        return 0

    stmt = insert(PortfolioHistory).values([
        {
            "user_id": user_id,
            "date": row["date"],
            "total_value": row["total_value"],
        }
        for row in rows_to_upsert
    ])
    stmt = stmt.on_conflict_do_update(
        index_elements=[PortfolioHistory.user_id, PortfolioHistory.date],
        set_={"total_value": stmt.excluded.total_value},
    )
    db.execute(stmt)
    return len(rows_to_upsert)
