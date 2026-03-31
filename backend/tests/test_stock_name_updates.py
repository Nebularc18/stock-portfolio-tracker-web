from types import SimpleNamespace

from app.main import StockUpdate
from app.routers import stocks


class FakeQuery:
    def __init__(self, value):
        self.value = value

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.value


class FakeDB:
    def __init__(self, stock):
        self.stock = stock

    def query(self, _model):
        return FakeQuery(self.stock)

    def commit(self):
        return None

    def refresh(self, _value):
        return None


def test_update_stock_accepts_manual_name_override():
    stock = SimpleNamespace(
        id=1,
        user_id=7,
        ticker="AAPL",
        name="Apple Inc.",
        quantity=2,
        purchase_price=100.0,
        purchase_date=None,
        position_entries=[],
        currency="USD",
        sector="Technology",
        current_price=190.0,
        previous_close=188.0,
        dividend_yield=None,
        dividend_per_share=None,
        logo=None,
    )

    updated = stocks.update_stock(
        ticker="AAPL",
        stock_data=StockUpdate(name="Apple"),
        db=FakeDB(stock),
        current_user=SimpleNamespace(id=7),
    )

    assert updated.name == "Apple"


def test_refresh_stock_preserves_manual_name(monkeypatch):
    stock = SimpleNamespace(
        user_id=7,
        ticker="SHEL.L",
        name="Shell",
        current_price=35.0,
        previous_close=34.5,
        dividend_yield=None,
        dividend_per_share=None,
        sector="Energy",
        logo=None,
    )

    class FakeStockService:
        def get_stock_info(self, ticker):
            assert ticker == "SHEL.L"
            return {
                "name": "Shell plc",
                "current_price": 35.83,
                "previous_close": 35.54,
                "dividend_yield": 4.1,
                "dividend_per_share": 1.48,
                "sector": "Energy",
            }

    monkeypatch.setattr("app.services.stock_service.StockService", FakeStockService)
    monkeypatch.setattr(stocks.brandfetch_service, "get_logo_url_for_ticker", lambda *args, **kwargs: None)

    refreshed = stocks.refresh_stock(
        ticker="SHEL.L",
        db=FakeDB(stock),
        current_user=SimpleNamespace(id=7),
    )

    assert refreshed.name == "Shell"
    assert refreshed.current_price == 35.83
    assert refreshed.previous_close == 35.54
