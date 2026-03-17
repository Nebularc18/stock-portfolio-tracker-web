from app.services import stock_service
from app.services.stock_service import StockService


def test_single_and_aggregate_analyst_caches_do_not_collide(monkeypatch):
    service = StockService()
    stock_service._ANALYST_SINGLE_CACHE.clear()
    stock_service._ANALYST_ALL_CACHE.clear()

    monkeypatch.setattr("app.services.stock_service._load_file_cache", lambda _filename: None)
    monkeypatch.setattr(
        "app.services.stock_service._save_file_cache",
        lambda _filename, _value, _ttl=3600: None,
    )
    monkeypatch.setattr(
        service,
        "_get_yfinance_recommendations",
        lambda _ticker: [{"period": "0m", "strong_buy": 1, "buy": 2, "hold": 0, "sell": 0, "strong_sell": 0, "total_analysts": 3}],
    )
    monkeypatch.setattr(service, "_get_finnhub_recommendations", lambda _ticker: None)

    single_result = service.get_analyst_recommendations("MSFT")
    all_result = service.get_all_analyst_recommendations("MSFT")

    assert isinstance(single_result, list)
    assert isinstance(all_result, dict)
    assert all_result["yfinance"] == single_result
    assert all_result["finnhub"] is None


def test_empty_analyst_result_uses_short_cache_ttl(monkeypatch):
    service = StockService()
    stock_service._ANALYST_ALL_CACHE.clear()
    saved = []

    monkeypatch.setattr("app.services.stock_service._load_file_cache", lambda _filename: None)
    monkeypatch.setattr(
        "app.services.stock_service._save_file_cache",
        lambda filename, value, ttl=3600: saved.append((filename, value, ttl)),
    )
    monkeypatch.setattr(service, "_get_yfinance_recommendations", lambda _ticker: None)
    monkeypatch.setattr(service, "_get_finnhub_recommendations", lambda _ticker: None)

    result = service.get_all_analyst_recommendations("MSFT")

    assert result == {"yfinance": None, "finnhub": None}
    assert saved[-1][2] == stock_service._ANALYST_NEGATIVE_CACHE_TTL


def test_legacy_empty_aggregate_cache_is_ignored(monkeypatch):
    service = StockService()
    stock_service._ANALYST_ALL_CACHE.clear()

    monkeypatch.setattr(
        "app.services.stock_service._load_file_cache",
        lambda _filename: {"yfinance": None, "finnhub": None},
    )
    monkeypatch.setattr(
        "app.services.stock_service._save_file_cache",
        lambda _filename, _value, _ttl=3600: None,
    )
    monkeypatch.setattr(
        service,
        "_get_yfinance_recommendations",
        lambda _ticker: [{"period": "0m", "strong_buy": 1, "buy": 2, "hold": 0, "sell": 0, "strong_sell": 0, "total_analysts": 3}],
    )
    monkeypatch.setattr(service, "_get_finnhub_recommendations", lambda _ticker: None)

    result = service.get_all_analyst_recommendations("MSFT")

    assert result["yfinance"] is not None


def test_marked_empty_aggregate_cache_is_respected(monkeypatch):
    service = StockService()
    stock_service._ANALYST_ALL_CACHE.clear()

    monkeypatch.setattr(
        "app.services.stock_service._load_file_cache",
        lambda _filename: {
            "cache_status": "hit",
            "cache_kind": stock_service._ANALYST_ALL_CACHE_KIND,
            "has_recommendations": False,
            "yfinance": None,
            "finnhub": None,
        },
    )
    monkeypatch.setattr(
        service,
        "_get_yfinance_recommendations",
        lambda _ticker: (_ for _ in ()).throw(AssertionError("should not refetch yfinance recommendations")),
    )
    monkeypatch.setattr(
        service,
        "_get_finnhub_recommendations",
        lambda _ticker: (_ for _ in ()).throw(AssertionError("should not refetch finnhub recommendations")),
    )

    result = service.get_all_analyst_recommendations("MSFT")

    assert result == {"yfinance": None, "finnhub": None}


def test_price_target_fallback_uses_short_cache_ttl(monkeypatch):
    service = StockService()
    stock_service._PRICE_TARGETS_CACHE.clear()
    saved = []

    monkeypatch.setattr("app.services.stock_service._load_file_cache", lambda _filename: None)
    monkeypatch.setattr(
        "app.services.stock_service._save_file_cache",
        lambda filename, value, ttl=3600: saved.append((filename, value, ttl)),
    )
    monkeypatch.setattr(
        "app.services.stock_service.importlib.import_module",
        lambda _name: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    monkeypatch.setattr(
        service,
        "get_quote_extended",
        lambda _ticker: {
            "fifty_two_week_high": 555.45,
            "fifty_two_week_low": 344.79,
            "currency": "USD",
        },
    )

    result = service.get_price_targets("MSFT")

    assert result == {
        "current": None,
        "targetAvg": None,
        "targetHigh": 555.45,
        "targetLow": 344.79,
        "numberOfAnalysts": None,
        "note": "52-week range (analyst targets unavailable)",
    }
    assert saved[-1][2] == stock_service._PRICE_TARGETS_FALLBACK_CACHE_TTL


def test_marked_empty_price_target_cache_is_respected(monkeypatch):
    service = StockService()
    stock_service._PRICE_TARGETS_CACHE.clear()

    monkeypatch.setattr(
        "app.services.stock_service._load_file_cache",
        lambda _filename: {
            "cache_status": "hit",
            "cache_kind": stock_service._PRICE_TARGETS_CACHE_KIND,
            "has_price_targets": False,
            "value": None,
        },
    )
    monkeypatch.setattr(
        "app.services.stock_service.importlib.import_module",
        lambda _name: (_ for _ in ()).throw(AssertionError("should not refetch yfinance price targets")),
    )
    monkeypatch.setattr(
        service,
        "get_quote_extended",
        lambda _ticker: (_ for _ in ()).throw(AssertionError("should not refetch fallback price targets")),
    )

    result = service.get_price_targets("MSFT")

    assert result is None


def test_quote_page_fallback_extracts_recommendations_and_targets(monkeypatch):
    service = StockService()
    stock_service._YAHOO_ANALYST_PAGE_CACHE.clear()

    html = """
    <html><body>
    <script type="application/json" data-sveltekit-fetched data-url="https://query1.finance.yahoo.com/v10/finance/quoteSummary/MSFT?formatted=true&amp;modules=summaryProfile%2CfinancialData%2CrecommendationTrend&amp;lang=en-US&amp;region=US" data-ttl="1">{"status":200,"statusText":"OK","headers":{},"body":"{\\"quoteSummary\\":{\\"result\\":[{\\"recommendationTrend\\":{\\"trend\\":[{\\"period\\":\\"0m\\",\\"strongBuy\\":10,\\"buy\\":44,\\"hold\\":3,\\"sell\\":0,\\"strongSell\\":0}]},\\"financialData\\":{\\"targetHighPrice\\":{\\"raw\\":730.0},\\"targetLowPrice\\":{\\"raw\\":392.0},\\"targetMeanPrice\\":{\\"raw\\":594.6217},\\"currentPrice\\":{\\"raw\\":395.55},\\"numberOfAnalystOpinions\\":{\\"raw\\":53}}}]}}"}</script>
    </body></html>
    """

    class FakeResponse:
        status_code = 200
        text = html

    class FakeSession:
        def get(self, url, timeout):
            assert "finance.yahoo.com/quote/MSFT" in url
            assert timeout == 15
            return FakeResponse()

    monkeypatch.setattr("app.services.stock_service.get_session", lambda: FakeSession())

    recommendations = service._get_quote_page_recommendations("MSFT")
    price_targets = service._get_quote_page_price_targets("MSFT")

    assert recommendations == [{
        "period": "0m",
        "strong_buy": 10,
        "buy": 44,
        "hold": 3,
        "sell": 0,
        "strong_sell": 0,
        "total_analysts": 57,
    }]
    assert price_targets == {
        "current": 395.55,
        "targetAvg": 594.6217,
        "targetHigh": 730.0,
        "targetLow": 392.0,
        "numberOfAnalysts": 53,
    }


def test_import_yfinance_forces_csrf_strategy(monkeypatch):
    calls = []

    class FakeYfData:
        def _set_cookie_strategy(self, strategy):
            calls.append(strategy)

    class FakeDataModule:
        YfData = FakeYfData

    fake_yfinance_module = object()

    def fake_import_module(name):
        if name == "yfinance":
            return fake_yfinance_module
        raise AssertionError(f"Unexpected import: {name}")

    monkeypatch.setattr("app.services.stock_service.importlib.import_module", fake_import_module)
    monkeypatch.setitem(__import__("sys").modules, "yfinance.data", FakeDataModule)

    imported = stock_service._import_yfinance_with_csrf_strategy()

    assert imported is fake_yfinance_module
    assert calls == ["csrf"]
