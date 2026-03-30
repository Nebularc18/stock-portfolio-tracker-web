from types import SimpleNamespace

from app.services.scheduler import _calculate_user_portfolio_totals_sek


def test_calculate_user_portfolio_totals_keeps_closed_market_holdings_in_total():
    stocks = [
        SimpleNamespace(
            user_id=7,
            ticker="SAP.DE",
            currency="EUR",
            current_price=100.0,
            quantity=10.0,
            purchase_price=90.0,
            purchase_date=None,
            position_entries=[],
        ),
        SimpleNamespace(
            user_id=7,
            ticker="MSFT",
            currency="USD",
            current_price=50.0,
            quantity=2.0,
            purchase_price=45.0,
            purchase_date=None,
            position_entries=[],
        ),
    ]

    totals, skipped = _calculate_user_portfolio_totals_sek(stocks, {
        "EUR_SEK": 11.0,
        "USD_SEK": 10.0,
    })

    assert totals == {7: 12000.0}
    assert skipped == {}


def test_calculate_user_portfolio_totals_marks_missing_prices_as_skipped():
    stocks = [
        SimpleNamespace(
            user_id=7,
            ticker="SAP.DE",
            currency="EUR",
            current_price=None,
            quantity=10.0,
            purchase_price=90.0,
            purchase_date=None,
            position_entries=[],
        ),
    ]

    totals, skipped = _calculate_user_portfolio_totals_sek(stocks, {"EUR_SEK": 11.0})

    assert totals == {}
    assert skipped == {7: 1}
