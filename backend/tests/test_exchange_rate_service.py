from app.services import exchange_rate_service
from app.services.exchange_rate_service import ExchangeRateService


def test_get_rates_for_currencies_synthesizes_bridge_rate_via_sek(monkeypatch):
    exchange_rate_service._cache.clear()

    prices = {
        "JPYSEK=X": 0.071,
        "SEKCAD=X": 0.132,
    }

    monkeypatch.setattr(
        "app.services.exchange_rate_service._fetch_latest_price",
        lambda symbol: prices[symbol],
    )

    rates = ExchangeRateService.get_rates_for_currencies({"JPY"}, "CAD")

    assert rates["JPY_CAD"] == prices["JPYSEK=X"] * prices["SEKCAD=X"]
