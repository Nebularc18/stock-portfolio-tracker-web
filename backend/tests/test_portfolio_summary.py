from datetime import date, datetime, timezone
from types import SimpleNamespace

from app.routers import portfolio


class FakeQuery:
    def __init__(self, value, delete_callback=None):
        self.value = value
        self.delete_callback = delete_callback

    def filter(self, *_args, **_kwargs):
        return self

    def all(self):
        return self.value

    def first(self):
        return self.value

    def order_by(self, *_args, **_kwargs):
        return self

    def join(self, *_args, **_kwargs):
        return self

    def delete(self, *_args, **_kwargs):
        if self.delete_callback:
            return self.delete_callback()
        if isinstance(self.value, list):
            deleted = len(self.value)
            self.value.clear()
            return deleted
        return 0


class FakeDB:
    def __init__(
        self,
        stocks,
        history_rows=None,
        settings=None,
        portfolio_history=None,
        dividends=None,
    ):
        self.stocks = stocks
        self.history_rows = history_rows or []
        self.settings = settings
        self.portfolio_history = portfolio_history or []
        self.dividends = dividends or []
        self.deleted = []

    def query(self, model):
        if model is portfolio.Stock:
            return FakeQuery(self.stocks)
        if model is portfolio.StockPriceHistory:
            return FakeQuery(self.history_rows)
        if model is portfolio.UserSettings:
            return FakeQuery(self.settings)
        if model is portfolio.PortfolioHistory:
            return FakeQuery(self.portfolio_history)
        if model is portfolio.Dividend:
            return FakeQuery(self.dividends)
        return FakeQuery(None)

    def add(self, value):
        if isinstance(value, portfolio.Stock):
            self.stocks.append(value)
        elif isinstance(value, portfolio.StockPriceHistory):
            self.history_rows.append(value)
        elif isinstance(value, portfolio.PortfolioHistory):
            self.portfolio_history.append(value)
        elif isinstance(value, portfolio.Dividend):
            self.dividends.append(value)
        elif isinstance(value, portfolio.UserSettings):
            self.settings = value

    def delete(self, value):
        self.deleted.append(value)
        if isinstance(value, portfolio.Stock) and value in self.stocks:
            self.stocks.remove(value)

    def flush(self):
        next_stock_id = 100
        for stock in self.stocks:
            if getattr(stock, "id", None) is None:
                stock.id = next_stock_id
                next_stock_id += 1

    def rollback(self):
        return None

    def commit(self):
        return None


def test_portfolio_summary_uses_avanza_dividends_for_yield(monkeypatch):
    stock = SimpleNamespace(
        ticker="VOLV-B.ST",
        name="Volvo",
        logo=None,
        sector="Industrials",
        currency="SEK",
        quantity=2,
        purchase_price=150.0,
        purchase_date=None,
        position_entries=[],
        current_price=200.0,
        previous_close=190.0,
        dividend_yield=None,
        dividend_per_share=None,
        last_updated=datetime(2026, 3, 31, tzinfo=timezone.utc),
    )

    monkeypatch.setattr(portfolio.brandfetch_service, "recover_stored_logo_url", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(portfolio, "get_display_currency", lambda *_args, **_kwargs: "SEK")
    monkeypatch.setattr(portfolio.ExchangeRateService, "get_rates_for_currencies", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        portfolio,
        "apply_position_snapshot",
        lambda current_stock: SimpleNamespace(
            quantity=current_stock.quantity,
            purchase_price=current_stock.purchase_price,
            position_entries=current_stock.position_entries,
        ),
    )
    monkeypatch.setattr(
        "app.services.avanza_service.avanza_service.get_mapping_by_ticker",
        lambda ticker: SimpleNamespace(instrument_id="145016") if ticker == "VOLV-B.ST" else None,
    )
    monkeypatch.setattr(
        "app.services.avanza_service.avanza_service.get_stock_dividends_for_year",
        lambda ticker, year: [
            SimpleNamespace(amount=8.0),
            SimpleNamespace(amount=2.0),
        ] if ticker == "VOLV-B.ST" and year == 2026 else [],
    )

    summary = portfolio.get_portfolio_summary(
        db=FakeDB([stock]),
        current_user=SimpleNamespace(id=7),
    )

    assert summary["dividend_yield"] == 5.0
    assert summary["dividend_yield_partial"] is False
    assert summary["daily_change"] == 20.0
    assert summary["daily_change_percent"] == 20.0 / 380.0 * 100
    assert summary["stocks"][0]["performance"]["today"]["amount"] == 20.0
    assert round(summary["stocks"][0]["performance"]["today"]["percent"], 6) == round(20.0 / 380.0 * 100, 6)
    assert summary["stocks"][0]["performance"]["since_start"]["amount"] == 100.0
    assert round(summary["stocks"][0]["performance"]["since_start"]["percent"], 6) == round(100.0 / 300.0 * 100, 6)


def test_should_auto_refresh_portfolio_ignores_unknown_markets(monkeypatch):
    stocks = [
        SimpleNamespace(ticker="AAPL"),
        SimpleNamespace(ticker="ASML.AS"),
    ]

    monkeypatch.setattr(
        "app.services.market_hours_service.MarketHoursService.infer_market_for_ticker",
        lambda ticker, assume_unsuffixed_us=False: "US" if ticker == "AAPL" else None,
    )
    monkeypatch.setattr(
        "app.services.market_hours_service.MarketHoursService.should_refresh",
        lambda markets: markets == ["US"],
    )

    assert portfolio._should_auto_refresh_portfolio(stocks) is True


def test_export_portfolio_data_includes_user_owned_records(monkeypatch):
    stock = SimpleNamespace(
        id=11,
        ticker="VOLV-B.ST",
        name="Volvo",
        logo="/static/logos/volvo.svg",
        sector="Industrials",
        currency="SEK",
        quantity=2,
        purchase_price=150.0,
        purchase_date=date(2026, 1, 5),
        position_entries=[{"id": "lot-1", "quantity": 2, "purchase_price": 150.0}],
        current_price=200.0,
        previous_close=190.0,
        dividend_yield=5.0,
        dividend_per_share=10.0,
        last_updated=datetime(2026, 3, 31, 12, 0, tzinfo=timezone.utc),
        manual_dividends=[{"id": "manual-1", "date": "2026-04-01", "amount": 2.0}],
        suppressed_dividends=[{"id": "suppressed-1", "date": "2026-05-01"}],
    )
    settings = SimpleNamespace(
        display_currency="EUR",
        header_indices='["^OMXS30"]',
        platforms='["Avanza"]',
    )
    portfolio_history = [
        SimpleNamespace(id=21, date=datetime(2026, 4, 1, tzinfo=timezone.utc), total_value=400.0),
    ]
    price_history = [
        SimpleNamespace(id=31, ticker="VOLV-B.ST", price=200.0, currency="SEK", recorded_at=datetime(2026, 4, 1, tzinfo=timezone.utc)),
    ]
    dividends = [
        SimpleNamespace(
            id=41,
            stock_id=11,
            amount=8.0,
            currency="SEK",
            ex_date=datetime(2026, 3, 28, tzinfo=timezone.utc),
            pay_date=datetime(2026, 4, 4, tzinfo=timezone.utc),
            created_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        ),
    ]
    mapping = SimpleNamespace(
        avanza_name="Volvo B",
        yahoo_ticker="VOLV-B.ST",
        instrument_id="145016",
        manually_added=True,
        added_at="2026-03-01T00:00:00+00:00",
    )

    monkeypatch.setattr(
        "app.services.avanza_service.avanza_service.get_relevant_mappings_for_user",
        lambda user_id: [mapping] if user_id == 7 else [],
    )
    monkeypatch.setattr(
        portfolio,
        "utc_now",
        lambda: datetime(2026, 4, 16, 10, 30, tzinfo=timezone.utc),
    )

    exported = portfolio.export_portfolio_data(
        db=FakeDB(
            [stock],
            history_rows=price_history,
            settings=settings,
            portfolio_history=portfolio_history,
            dividends=dividends,
        ),
        current_user=SimpleNamespace(
            id=7,
            username="demo",
            is_guest=False,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        ),
    )

    assert exported["export_version"] == 1
    assert exported["exported_at"] == "2026-04-16T10:30:00+00:00"
    assert "user" not in exported
    assert exported["settings"] == {
        "display_currency": "EUR",
        "header_indices": ["^OMXS30"],
        "platforms": ["Avanza"],
    }
    assert exported["stocks"][0]["ticker"] == "VOLV-B.ST"
    assert exported["stocks"][0]["purchase_date"] == "2026-01-05"
    assert "current_price" not in exported["stocks"][0]
    assert "previous_close" not in exported["stocks"][0]
    assert exported["stocks"][0]["manual_dividends"] == stock.manual_dividends
    assert exported["stocks"][0]["suppressed_dividends"] == stock.suppressed_dividends
    assert exported["dividends"][0]["ticker"] == "VOLV-B.ST"
    assert exported["portfolio_history"][0]["total_value"] == 400.0
    assert exported["stock_price_history"][0]["price"] == 200.0
    assert exported["ticker_mappings"][0]["avanza_name"] == "Volvo B"


def test_import_portfolio_data_replaces_user_records(monkeypatch):
    imported_mappings = []

    monkeypatch.setattr(
        "app.services.avanza_service.avanza_service.add_manual_mapping",
        lambda **kwargs: imported_mappings.append(kwargs) or SimpleNamespace(**kwargs),
    )

    db = FakeDB([])
    payload = {
        "export_version": 1,
        "settings": {
            "display_currency": "eur",
            "header_indices": ["^OMXS30"],
            "platforms": ["Avanza"],
        },
        "stocks": [{
            "id": 11,
            "ticker": "volv-b.st",
            "name": "Volvo",
            "quantity": 2,
            "currency": "sek",
            "sector": "Industrials",
            "purchase_price": 150,
            "purchase_date": "2026-01-05",
            "position_entries": [{"id": "lot-1", "quantity": 2, "purchase_price": 150}],
            "current_price": 200,
            "previous_close": 190,
            "manual_dividends": [{"id": "manual-1", "date": "2026-04-01", "amount": 2}],
            "suppressed_dividends": [{"id": "suppressed-1", "date": "2026-05-01"}],
        }],
        "dividends": [{
            "stock_id": 11,
            "ticker": "VOLV-B.ST",
            "amount": 8,
            "currency": "SEK",
            "ex_date": "2026-03-28T00:00:00+00:00",
            "pay_date": "2026-04-04T00:00:00+00:00",
        }],
        "portfolio_history": [{
            "date": "2026-04-01T00:00:00+00:00",
            "total_value": 400,
        }],
        "stock_price_history": [{
            "ticker": "VOLV-B.ST",
            "price": 200,
            "currency": "SEK",
            "recorded_at": "2026-04-01T00:00:00+00:00",
        }],
        "ticker_mappings": [{
            "avanza_name": "Volvo B",
            "yahoo_ticker": "VOLV-B.ST",
            "instrument_id": "145016",
        }],
    }

    result = portfolio.import_portfolio_data(
        payload=payload,
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert result["mode"] == "replace"
    assert result["stocks_imported"] == 1
    assert result["dividends_imported"] == 1
    assert result["portfolio_history_imported"] == 1
    assert result["stock_price_history_imported"] == 1
    assert db.settings.display_currency == "EUR"
    assert db.stocks[0].user_id == 7
    assert db.stocks[0].ticker == "VOLV-B.ST"
    assert db.stocks[0].purchase_date == date(2026, 1, 5)
    assert db.stocks[0].current_price is None
    assert db.stocks[0].previous_close is None
    assert db.stocks[0].manual_dividends == payload["stocks"][0]["manual_dividends"]
    assert db.stocks[0].suppressed_dividends == [{"date": "2026-05-01", "id": "suppressed-1"}]
    assert db.dividends[0].stock_id == db.stocks[0].id
    assert db.portfolio_history[0].user_id == 7
    assert db.history_rows[0].user_id == 7
    assert imported_mappings == [{
        "avanza_name": "Volvo B",
        "yahoo_ticker": "VOLV-B.ST",
        "instrument_id": "145016",
    }]
