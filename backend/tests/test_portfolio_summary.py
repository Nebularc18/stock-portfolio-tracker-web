from datetime import datetime, timezone
from types import SimpleNamespace

from app.routers import portfolio


class FakeQuery:
    def __init__(self, value):
        self.value = value

    def filter(self, *_args, **_kwargs):
        return self

    def all(self):
        return self.value

    def first(self):
        return self.value

    def order_by(self, *_args, **_kwargs):
        return self


class FakeDB:
    def __init__(self, stocks, history_rows=None):
        self.stocks = stocks
        self.history_rows = history_rows or []

    def query(self, model):
        if model is portfolio.Stock:
            return FakeQuery(self.stocks)
        if model is portfolio.StockPriceHistory:
            return FakeQuery(self.history_rows)
        return FakeQuery(None)

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
