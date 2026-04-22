from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import logging
import math
from typing import Any, Optional, Sequence

from sqlalchemy import and_, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.services.exchange_rate_service import ExchangeRateService
from app.services.position_service import get_quantity_held_on_date, has_position_history, normalize_position_entries

logger = logging.getLogger(__name__)
PORTFOLIO_HISTORY_BACKFILL_REL_TOL = 0.001
PORTFOLIO_HISTORY_BACKFILL_ABS_TOL_SEK = 25.0


def _normalize_history_timestamp(value: datetime | date) -> datetime:
    # PortfolioHistory and StockPriceHistory are treated as one-row-per-UTC-day
    # stores, so callers must normalize timestamps before writing them.
    if isinstance(value, datetime):
        normalized = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return normalized.replace(hour=0, minute=0, second=0, microsecond=0)
    return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)


def _convert_value(value: float, from_currency: str, to_currency: str, rates: dict[str, float | None]) -> Optional[float]:
    if from_currency == to_currency:
        return value

    key = f"{from_currency}_{to_currency}"
    direct_rate = rates.get(key)
    if direct_rate is not None:
        return value * direct_rate

    inverse_key = f"{to_currency}_{from_currency}"
    inverse_rate = rates.get(inverse_key)
    if inverse_rate is not None and inverse_rate != 0:
        return value / inverse_rate

    if from_currency != "SEK" and to_currency != "SEK":
        sek_value = _convert_value(value, from_currency, "SEK", rates)
        if sek_value is None:
            return None
        return _convert_value(sek_value, "SEK", to_currency, rates)

    return None


def _is_close_portfolio_total(existing_value: Any, recalculated_value: float) -> bool:
    try:
        normalized_existing = float(existing_value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(normalized_existing) or not math.isfinite(recalculated_value):
        return False
    return math.isclose(
        normalized_existing,
        recalculated_value,
        rel_tol=PORTFOLIO_HISTORY_BACKFILL_REL_TOL,
        abs_tol=PORTFOLIO_HISTORY_BACKFILL_ABS_TOL_SEK,
    )


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

    existing_history_by_day = {
        _normalize_history_timestamp(getattr(row, "date")).date(): getattr(row, "total_value", None)
        for row in existing_history_rows
        if getattr(row, "date", None) is not None
    }

    missing_rows: list[dict[str, Any]] = []
    sorted_snapshot_days = sorted(snapshot_days)
    price_indexes = [0] * len(tracked_stocks)
    latest_rows: list[Any | None] = [None] * len(tracked_stocks)

    for snapshot_day in sorted_snapshot_days:
        # When backfilling from a specific purchase date we need to recompute the
        # affected window, not just fill gaps, because existing rows may have been
        # persisted from partial data before the missing stock history was added.
        existing_total_value = existing_history_by_day.get(snapshot_day.date())
        if start_date is None and existing_total_value is not None:
            continue

        total_value_sek = 0.0
        eligible_positions = 0
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

            # Position helper uses an exclusive purchase-date boundary, so use the
            # next day to evaluate end-of-day holdings for this snapshot date.
            quantity = get_quantity_held_on_date(
                stock_data["position_entries"],
                snapshot_day.date() + timedelta(days=1),
            )
            if quantity <= 0:
                continue
            eligible_positions += 1

            latest_row = latest_rows[stock_index]
            if latest_row is None:
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

        if included_positions < eligible_positions:
            logger.debug(
                "Backfilled partial portfolio history snapshot for %s: included %s of %s held positions",
                snapshot_day.date().isoformat(),
                included_positions,
                eligible_positions,
            )

        if start_date is not None and existing_total_value is not None and _is_close_portfolio_total(existing_total_value, total_value_sek):
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
    portfolio_history_model: Any = None,
    stock_model: Any = None,
    stock_price_history_model: Any = None,
) -> int:
    if portfolio_history_model is None or stock_model is None or stock_price_history_model is None:
        from app.main import PortfolioHistory, Stock, StockPriceHistory

        portfolio_history_model = PortfolioHistory if portfolio_history_model is None else portfolio_history_model
        stock_model = Stock if stock_model is None else stock_model
        stock_price_history_model = StockPriceHistory if stock_price_history_model is None else stock_price_history_model

    stocks = db.query(stock_model).filter(stock_model.user_id == user_id).all()
    tickers = [str(getattr(stock, "ticker", "") or "").upper() for stock in stocks if getattr(stock, "ticker", None)]
    if not tickers:
        return 0

    normalized_start = _normalize_history_timestamp(start_date) if start_date is not None else None
    price_query = db.query(stock_price_history_model).filter(
        stock_price_history_model.user_id == user_id,
        stock_price_history_model.ticker.in_(tickers),
    )
    if normalized_start is None:
        price_rows = price_query.order_by(
            stock_price_history_model.ticker.asc(),
            stock_price_history_model.recorded_at.asc(),
        ).all()
    else:
        anchor_day_subquery = db.query(
            stock_price_history_model.ticker.label("ticker"),
            func.max(func.date_trunc("day", stock_price_history_model.recorded_at)).label("anchor_day"),
        ).filter(
            stock_price_history_model.user_id == user_id,
            stock_price_history_model.ticker.in_(tickers),
            stock_price_history_model.recorded_at < normalized_start,
        ).group_by(
            stock_price_history_model.ticker,
        ).subquery()
        anchor_timestamp_subquery = db.query(
            stock_price_history_model.ticker.label("ticker"),
            func.max(stock_price_history_model.recorded_at).label("recorded_at"),
        ).join(
            anchor_day_subquery,
            and_(
                stock_price_history_model.ticker == anchor_day_subquery.c.ticker,
                func.date_trunc("day", stock_price_history_model.recorded_at) == anchor_day_subquery.c.anchor_day,
            ),
        ).filter(
            stock_price_history_model.user_id == user_id,
            stock_price_history_model.ticker.in_(tickers),
        ).group_by(
            stock_price_history_model.ticker,
        ).subquery()
        anchor_rows = db.query(stock_price_history_model).join(
            anchor_timestamp_subquery,
            and_(
                stock_price_history_model.ticker == anchor_timestamp_subquery.c.ticker,
                stock_price_history_model.recorded_at == anchor_timestamp_subquery.c.recorded_at,
            ),
        ).filter(
            stock_price_history_model.user_id == user_id,
        ).order_by(
            stock_price_history_model.ticker.asc(),
            stock_price_history_model.recorded_at.asc(),
        ).all()
        from_start_rows = price_query.filter(
            stock_price_history_model.recorded_at >= normalized_start,
        ).order_by(
            stock_price_history_model.ticker.asc(),
            stock_price_history_model.recorded_at.asc(),
        ).all()
        price_rows = [*anchor_rows, *from_start_rows]
    if not price_rows:
        return 0

    existing_history_query = db.query(portfolio_history_model).filter(portfolio_history_model.user_id == user_id)
    if normalized_start is not None:
        # Snapshot days are also bounded to start_date, so loading existing history
        # from normalized_start onward is enough to suppress same-day rewrites.
        existing_history_query = existing_history_query.filter(
            portfolio_history_model.date >= normalized_start,
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

    stmt = insert(portfolio_history_model).values([
        {
            "user_id": user_id,
            "date": _normalize_history_timestamp(row["date"]),
            "total_value": row["total_value"],
        }
        for row in rows_to_upsert
    ])
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "date"],
        set_={"total_value": stmt.excluded.total_value},
    )
    db.execute(stmt)
    return len(rows_to_upsert)
