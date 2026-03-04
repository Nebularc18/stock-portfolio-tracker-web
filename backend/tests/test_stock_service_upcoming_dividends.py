from types import SimpleNamespace
from datetime import datetime, timezone

from app.services.stock_service import StockService
from app.services.avanza_service import AvanzaDividend


class TestStockServiceUpcomingDividends:
    def test_mapped_ticker_uses_avanza_first_for_non_st(self, monkeypatch):
        service = StockService()

        mapping = SimpleNamespace(instrument_id="123")
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_mapping_by_ticker",
            lambda ticker: mapping,
        )
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_stock_dividends",
            lambda ticker: [
                AvanzaDividend(
                    avanza_name="Microsoft",
                    ex_date="2026-03-12",
                    amount=3.64,
                    currency="USD",
                    payment_date="2026-03-20",
                    yahoo_ticker="MSFT",
                    instrument_id="123",
                    dividend_type="ordinary",
                )
            ],
        )

        def _fail_yfinance_import(_name):
            raise AssertionError("yfinance fallback should not be used for mapped ticker with Avanza data")

        monkeypatch.setattr("app.services.stock_service.importlib.import_module", _fail_yfinance_import)

        upcoming = service.get_upcoming_dividends("MSFT")

        assert len(upcoming) == 1
        assert upcoming[0]["source"] == "avanza"
        assert upcoming[0]["ex_date"] == "2026-03-12"
        assert upcoming[0]["payment_date"] == "2026-03-20"
        assert upcoming[0]["dividend_type"] == "ordinary"

    def test_mapped_ticker_returns_multiple_avanza_events(self, monkeypatch):
        service = StockService()

        mapping = SimpleNamespace(instrument_id="145016")
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_mapping_by_ticker",
            lambda ticker: mapping,
        )
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_stock_dividends",
            lambda ticker: [
                AvanzaDividend(
                    avanza_name="Volvo",
                    ex_date="2026-04-09",
                    amount=8.0,
                    currency="SEK",
                    payment_date="2026-04-15",
                    yahoo_ticker="VOLV-B.ST",
                    instrument_id="145016",
                    dividend_type="ordinary",
                ),
                AvanzaDividend(
                    avanza_name="Volvo",
                    ex_date="2026-04-09",
                    amount=10.5,
                    currency="SEK",
                    payment_date="2026-04-15",
                    yahoo_ticker="VOLV-B.ST",
                    instrument_id="145016",
                    dividend_type="bonus",
                ),
            ],
        )

        upcoming = service.get_upcoming_dividends("VOLV-B.ST")

        assert len(upcoming) == 2
        assert [item["dividend_type"] for item in upcoming] == ["ordinary", "bonus"]
        assert all(item["source"] == "avanza" for item in upcoming)

    def test_mapped_ticker_without_avanza_events_returns_empty(self, monkeypatch):
        service = StockService()

        mapping = SimpleNamespace(instrument_id="123")
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_mapping_by_ticker",
            lambda ticker: mapping,
        )
        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_stock_dividends",
            lambda ticker: [],
        )

        def _fail_yfinance_import(_name):
            raise AssertionError("yfinance fallback should not be used for mapped tickers")

        monkeypatch.setattr("app.services.stock_service.importlib.import_module", _fail_yfinance_import)

        upcoming = service.get_upcoming_dividends("KO")

        assert upcoming == []

    def test_unmapped_yahoo_includes_payment_date(self, monkeypatch):
        service = StockService()

        monkeypatch.setattr(
            "app.services.stock_service.avanza_service.get_mapping_by_ticker",
            lambda ticker: None,
        )

        class FakeYFTicker:
            def __init__(self):
                self.info = {
                    "exDividendDate": 1772928000,
                    "dividendDate": 1773532800,
                    "dividendRate": 0.91,
                    "currency": "USD",
                }
                self.calendar = None
                self.dividends = []

        class FakeYFModule:
            @staticmethod
            def Ticker(_ticker):
                return FakeYFTicker()

        monkeypatch.setattr(
            "app.services.stock_service.importlib.import_module",
            lambda name: FakeYFModule if name == "yfinance" else None,
        )

        upcoming = service.get_upcoming_dividends("MSFT")

        expected_ex_date = datetime.fromtimestamp(1772928000, tz=timezone.utc).strftime("%Y-%m-%d")
        expected_payment_date = datetime.fromtimestamp(1773532800, tz=timezone.utc).strftime("%Y-%m-%d")

        assert len(upcoming) == 1
        assert upcoming[0]["source"] == "yahoo"
        assert upcoming[0]["ex_date"] == expected_ex_date
        assert upcoming[0]["payment_date"] == expected_payment_date
