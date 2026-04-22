from datetime import date, datetime, timezone
from types import SimpleNamespace

from app.routers import stocks
from app.services.stock_service import StockService


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeQuery:
    def __init__(self, value):
        self.value = value

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        if isinstance(self.value, list):
            return self.value[0] if self.value else None
        return self.value

    def all(self):
        return list(self.value) if isinstance(self.value, list) else self.value

    def order_by(self, *_args, **_kwargs):
        return self


class FakeDB:
    def __init__(self, stocks_list=None, history_rows=None):
        self.stocks = stocks_list or []
        self.history_rows = history_rows or []
        self.committed = False
        self.closed = False
        self.rolled_back = False

    def query(self, model):
        if model is stocks.Stock:
            return FakeQuery(self.stocks)
        if model is stocks.StockPriceHistory:
            return FakeQuery(self.history_rows)
        return FakeQuery(None)

    def add(self, value):
        self.stocks.append(value)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def refresh(self, _value):
        return None

    def close(self):
        self.closed = True


def test_get_daily_price_history_parses_yahoo_chart_rows(monkeypatch):
    captured = {}
    timestamps = [
        int(datetime(2026, 1, 2, tzinfo=timezone.utc).timestamp()),
        int(datetime(2026, 1, 5, tzinfo=timezone.utc).timestamp()),
        int(datetime(2026, 1, 6, tzinfo=timezone.utc).timestamp()),
    ]
    payload = {
        "chart": {
            "result": [{
                "meta": {"currency": "GBP"},
                "timestamp": timestamps,
                "indicators": {
                    "quote": [{
                        "close": [123.0, None, 150.0],
                    }]
                },
            }]
        }
    }

    class FakeSession:
        def get(self, url, timeout):
            captured["url"] = url
            captured["timeout"] = timeout
            return FakeResponse(200, payload)

    monkeypatch.setattr("app.services.stock_service.get_session", lambda: FakeSession())

    service = StockService()
    rows = service.get_daily_price_history("VOD.L", date(2026, 1, 2), date(2026, 1, 6))

    assert "interval=1d" in captured["url"]
    assert captured["timeout"] == 10
    assert rows == [
        {
            "recorded_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
            "price": 1.23,
            "currency": "GBP",
        },
        {
            "recorded_at": datetime(2026, 1, 6, tzinfo=timezone.utc),
            "price": 1.5,
            "currency": "GBP",
        },
    ]


def test_backfill_stock_price_history_fetches_missing_range_and_today_quote(monkeypatch):
    existing_rows = [
        SimpleNamespace(
            ticker="MSFT",
            price=140.0,
            currency="USD",
            recorded_at=datetime(2026, 1, 10, tzinfo=timezone.utc),
        ),
    ]
    db = FakeDB(history_rows=existing_rows)
    captured = {}

    class FakeStockService:
        def __init__(self):
            self.calls = []

        def get_daily_price_history(self, ticker, start_date, end_date):
            self.calls.append((ticker, start_date, end_date))
            return [
                {
                    "recorded_at": datetime(2026, 1, 5, tzinfo=timezone.utc),
                    "price": 130.0,
                    "currency": "USD",
                },
                {
                    "recorded_at": datetime(2026, 1, 6, tzinfo=timezone.utc),
                    "price": 131.0,
                    "currency": "USD",
                },
            ]

    def fake_upsert(_db, user_id, ticker, rows):
        captured["user_id"] = user_id
        captured["ticker"] = ticker
        captured["rows"] = rows
        return len(rows)

    fixed_now = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
    service = FakeStockService()

    monkeypatch.setattr(stocks, "_upsert_stock_price_history_rows", fake_upsert)
    monkeypatch.setattr(stocks, "utc_now", lambda: fixed_now)

    count = stocks._backfill_stock_price_history(
        db,
        user_id=7,
        ticker="MSFT",
        purchase_date=date(2026, 1, 5),
        stock_service=service,
        current_price=155.0,
        current_currency="USD",
    )

    assert service.calls == [("MSFT", date(2026, 1, 5), date(2026, 1, 9))]
    assert count == 3
    assert captured["user_id"] == 7
    assert captured["ticker"] == "MSFT"
    assert captured["rows"][-1] == {
        "recorded_at": datetime(2026, 1, 15, tzinfo=timezone.utc),
        "price": 155.0,
        "currency": "USD",
    }


def test_backfill_after_commit_uses_separate_session(monkeypatch):
    captured = {}
    history_db = FakeDB()

    class FakeStockService:
        pass

    def fake_backfill(db, user_id, ticker, purchase_date, stock_service, current_price=None, current_currency=None):
        captured["db"] = db
        captured["user_id"] = user_id
        captured["ticker"] = ticker
        captured["purchase_date"] = purchase_date
        captured["stock_service"] = stock_service
        captured["current_price"] = current_price
        captured["current_currency"] = current_currency
        return 2

    monkeypatch.setattr(stocks, "SessionLocal", lambda: history_db)
    monkeypatch.setattr(stocks, "_backfill_stock_price_history", fake_backfill)

    service = FakeStockService()
    count = stocks._backfill_stock_price_history_after_commit(
        user_id=7,
        ticker="MSFT",
        purchase_date=date(2025, 4, 1),
        stock_service=service,
        current_price=123.45,
        current_currency="USD",
    )

    assert count == 2
    assert captured["db"] is history_db
    assert captured["user_id"] == 7
    assert captured["ticker"] == "MSFT"
    assert captured["purchase_date"] == date(2025, 4, 1)
    assert captured["stock_service"] is service
    assert captured["current_price"] == 123.45
    assert captured["current_currency"] == "USD"
    assert history_db.committed is True
    assert history_db.closed is True


def test_create_stock_triggers_post_commit_price_history_backfill(monkeypatch):
    captured = {}
    fixed_now = datetime(2026, 4, 22, 9, 30, tzinfo=timezone.utc)

    class FakeStockService:
        def validate_ticker(self, ticker):
            captured["validated_ticker"] = ticker
            return True

        def get_stock_info(self, ticker):
            captured["info_ticker"] = ticker
            return {
                "name": "Microsoft",
                "current_price": 123.45,
                "previous_close": 120.0,
                "currency": "USD",
                "sector": "Technology",
                "dividend_yield": 1.0,
                "dividend_per_share": 2.0,
            }

    def fake_backfill(user_id, ticker, purchase_date, stock_service, current_price=None, current_currency=None):
        captured["backfill"] = {
            "user_id": user_id,
            "ticker": ticker,
            "purchase_date": purchase_date,
            "stock_service": stock_service,
            "current_price": current_price,
            "current_currency": current_currency,
        }
        return 4

    monkeypatch.setattr("app.services.stock_service.StockService", FakeStockService)
    monkeypatch.setattr("app.services.avanza_service.avanza_service.ensure_mapping_for_ticker", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("app.services.brandfetch_service.brandfetch_service.get_logo_url_for_ticker", lambda *_args, **_kwargs: "logo-url")
    monkeypatch.setattr(stocks, "_backfill_stock_price_history_after_commit", fake_backfill)
    monkeypatch.setattr(stocks, "utc_now", lambda: fixed_now)

    db = FakeDB()
    payload = {
        "ticker": "msft",
        "quantity": 2,
        "purchase_price": 100.0,
        "purchase_date": date(2025, 4, 1),
    }

    created = stocks.create_stock(
        payload=payload,
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert db.committed is True
    assert created.ticker == "MSFT"
    assert created.current_price == 123.45
    assert captured["validated_ticker"] == "MSFT"
    assert captured["info_ticker"] == "MSFT"
    assert captured["backfill"]["user_id"] == 7
    assert captured["backfill"]["ticker"] == "MSFT"
    assert captured["backfill"]["purchase_date"] == date(2025, 4, 1)
    assert captured["backfill"]["current_price"] == 123.45
    assert captured["backfill"]["current_currency"] == "USD"
