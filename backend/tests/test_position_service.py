import pytest

from app.services.position_service import (
    calculate_position_cost_basis,
    calculate_position_snapshot,
    get_quantity_held_on_date,
    normalize_position_entries,
    validate_position_entries,
)


def test_validate_position_entries_requires_list():
    with pytest.raises(ValueError, match="position_entries must be a list"):
        validate_position_entries("not-a-list")


def test_normalize_position_entries_persists_generated_ids():
    entry = {
        "quantity": 2,
        "purchase_price": 10,
        "purchase_date": "2024-01-01",
        "sell_date": None,
    }

    first = normalize_position_entries([entry])
    second = normalize_position_entries([entry])

    assert first[0]["id"] == second[0]["id"]
    assert entry["id"] == first[0]["id"]


def test_validate_position_entries_rejects_malformed_lot_before_normalization():
    with pytest.raises(ValueError, match="quantity must be a number"):
        validate_position_entries([{
            "quantity": "abc",
            "purchase_price": 10,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


def test_validate_position_entries_rejects_invalid_dates():
    with pytest.raises(ValueError, match="purchase_date must be a valid date"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": 10,
            "purchase_date": "not-a-date",
            "sell_date": None,
        }])


def test_get_quantity_held_on_date_uses_fallback_position():
    quantity = get_quantity_held_on_date(
        None,
        "2024-02-01",
        fallback_quantity=3,
        fallback_purchase_price=10,
        fallback_purchase_date="2024-01-01",
    )

    assert quantity == 3


def test_normalize_position_entries_uses_stable_fallback_id():
    first = normalize_position_entries(
        None,
        fallback_quantity=3,
        fallback_purchase_price=10,
        fallback_purchase_date="2024-01-01",
    )
    second = normalize_position_entries(
        None,
        fallback_quantity=3,
        fallback_purchase_price=10,
        fallback_purchase_date="2024-01-01",
    )

    assert first[0]["id"] == second[0]["id"]


def test_get_quantity_held_on_date_includes_lot_sold_on_target_date():
    quantity = get_quantity_held_on_date(
        [{
            "quantity": 5,
            "purchase_price": 10,
            "purchase_date": "2024-01-01",
            "sell_date": "2024-02-01",
        }],
        "2024-02-01",
    )

    assert quantity == 5


def test_validate_position_entries_rejects_negative_courtage():
    with pytest.raises(ValueError, match="courtage must be greater than or equal to zero"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": 10,
            "courtage": -1,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


def test_validate_position_entries_requires_purchase_price_when_courtage_present():
    with pytest.raises(ValueError, match="courtage requires purchase_price"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": None,
            "courtage": 5,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


def test_calculate_position_snapshot_includes_courtage_in_effective_purchase_price():
    snapshot = calculate_position_snapshot([{
        "quantity": 2,
        "purchase_price": 100,
        "courtage": 10,
        "purchase_date": "2024-01-01",
        "sell_date": None,
    }])

    assert snapshot["purchase_price"] == pytest.approx(105.0)


def test_validate_position_entries_requires_exchange_rate_currency_when_rate_present():
    with pytest.raises(ValueError, match="exchange_rate requires exchange_rate_currency"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": 10,
            "exchange_rate": 10.5,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


def test_normalize_position_entries_preserves_exchange_rate_fields():
    normalized = normalize_position_entries([{
        "quantity": 1,
        "purchase_price": 10,
        "exchange_rate": 10.5,
        "exchange_rate_currency": "sek",
        "purchase_date": "2024-01-01",
        "sell_date": None,
    }])

    assert normalized[0]["exchange_rate"] == pytest.approx(10.5)
    assert normalized[0]["exchange_rate_currency"] == "SEK"


def test_calculate_position_cost_basis_prefers_stored_exchange_rate_for_target_currency():
    total_cost = calculate_position_cost_basis(
        [{
            "quantity": 2,
            "purchase_price": 100,
            "courtage": 10,
            "exchange_rate": 10.0,
            "exchange_rate_currency": "SEK",
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }],
        "USD",
        "SEK",
        conversion_callback=lambda amount, from_currency, to_currency: None,
    )

    assert total_cost == pytest.approx(2100.0)
