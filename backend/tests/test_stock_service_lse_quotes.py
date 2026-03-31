from app.services.stock_service import fetch_yahoo_quote


class _FakeResponse:
    status_code = 200

    @staticmethod
    def json():
        return {
            "chart": {
                "result": [
                    {
                        "meta": {
                            "currency": "GBP",
                            "shortName": "Shell plc",
                            "fiftyTwoWeekHigh": 3650.0,
                            "fiftyTwoWeekLow": 2500.0,
                        },
                        "indicators": {
                            "quote": [
                                {
                                    "close": [3553.5, 3583.0],
                                }
                            ]
                        },
                    }
                ]
            }
        }


class _FakeSession:
    @staticmethod
    def get(_url, timeout=10):
        assert timeout == 10
        return _FakeResponse()


def test_fetch_yahoo_quote_normalizes_london_prices_from_pence(monkeypatch):
    monkeypatch.setattr("app.services.stock_service._load_file_cache", lambda _filename: None)
    monkeypatch.setattr("app.services.stock_service.get_session", lambda: _FakeSession())
    monkeypatch.setattr("app.services.stock_service._save_file_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("app.services.stock_service._TICKER_CACHE", {})

    quote = fetch_yahoo_quote("SHEL.L")

    assert quote is not None
    assert quote["currency"] == "GBP"
    assert quote["current_price"] == 35.83
    assert quote["previous_close"] == 35.535
    assert quote["fifty_two_week_high"] == 36.5
    assert quote["fifty_two_week_low"] == 25.0
