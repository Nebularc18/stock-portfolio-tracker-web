import pytest
import logging

from app.services.position_service import (
    apply_stock_split,
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


def test_validate_position_entries_rejects_sold_quantity_above_lot_quantity():
    with pytest.raises(ValueError, match="sold_quantity cannot exceed quantity"):
        validate_position_entries([{
            "quantity": 5,
            "sold_quantity": 6,
            "purchase_price": 10,
            "purchase_date": "2024-01-01",
            "sell_date": "2024-02-01",
        }])


def test_validate_position_entries_requires_sell_date_when_sold_quantity_present():
    with pytest.raises(ValueError, match="sold_quantity requires sell_date"):
        validate_position_entries([{
            "quantity": 5,
            "sold_quantity": 2,
            "purchase_price": 10,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


def test_get_quantity_held_on_date_uses_remaining_quantity_after_partial_sale():
    quantity = get_quantity_held_on_date(
        [{
            "quantity": 5,
            "sold_quantity": 2,
            "purchase_price": 10,
            "purchase_date": "2024-01-01",
            "sell_date": "2024-02-01",
        }],
        "2024-02-02",
    )

    assert quantity == 3


def test_calculate_position_snapshot_uses_remaining_quantity_for_partial_sale():
    snapshot = calculate_position_snapshot([{
        "quantity": 10,
        "sold_quantity": 4,
        "purchase_price": 100,
        "courtage": 10,
        "purchase_date": "2024-01-01",
        "sell_date": "2024-02-01",
    }])

    assert snapshot["quantity"] == pytest.approx(6)
    assert snapshot["purchase_price"] == pytest.approx(101.0)


def test_calculate_position_cost_basis_prorates_courtage_for_partial_sale():
    total_cost = calculate_position_cost_basis(
        [{
            "quantity": 10,
            "sold_quantity": 4,
            "purchase_price": 100,
            "courtage": 10,
            "purchase_date": "2024-01-01",
            "sell_date": "2024-02-01",
        }],
        "USD",
        "USD",
    )

    assert total_cost == pytest.approx(606.0)


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


def test_calculate_position_snapshot_converts_courtage_from_exchange_rate_currency():
    snapshot = calculate_position_snapshot([{
        "quantity": 2,
        "purchase_price": 100,
        "courtage": 10,
        "courtage_currency": "SEK",
        "exchange_rate": 10,
        "exchange_rate_currency": "SEK",
        "purchase_date": "2024-01-01",
        "sell_date": None,
    }])

    assert snapshot["purchase_price"] == pytest.approx(100.5)


def test_calculate_position_snapshot_warns_and_keeps_unconverted_courtage(caplog):
    with caplog.at_level(logging.WARNING):
        snapshot = calculate_position_snapshot([{
            "quantity": 2,
            "purchase_price": 100,
            "courtage": 10,
            "courtage_currency": "EUR",
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])

    assert snapshot["purchase_price"] == pytest.approx(105.0)
    assert "Unable to convert courtage for position snapshot" in caplog.text


def test_calculate_position_snapshot_uses_conversion_callback_for_courtage():
    snapshot = calculate_position_snapshot(
        [{
            "quantity": 1,
            "purchase_price": 100,
            "courtage": 10,
            "courtage_currency": "EUR",
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }],
        position_currency="USD",
        conversion_callback=lambda amount, from_currency, to_currency: 11.0 if (amount, from_currency, to_currency) == (10.0, "EUR", "USD") else None,
    )

    assert snapshot["purchase_price"] == pytest.approx(111.0)


def test_calculate_position_snapshot_keeps_native_courtage_without_warning(caplog):
    with caplog.at_level(logging.WARNING):
        snapshot = calculate_position_snapshot(
            [{
                "quantity": 1,
                "purchase_price": 100,
                "courtage": 10,
                "courtage_currency": "USD",
                "purchase_date": "2024-01-01",
                "sell_date": None,
            }],
            position_currency="USD",
        )

    assert snapshot["purchase_price"] == pytest.approx(110.0)
    assert "Unable to convert courtage for position snapshot" not in caplog.text


def test_validate_position_entries_requires_exchange_rate_currency_when_rate_present():
    with pytest.raises(ValueError, match="exchange_rate requires exchange_rate_currency"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": 10,
            "exchange_rate": 10.5,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


@pytest.mark.parametrize("invalid_exchange_rate", [float("nan"), float("inf"), float("-inf")])
def test_validate_position_entries_rejects_non_finite_exchange_rate(invalid_exchange_rate):
    with pytest.raises(ValueError, match="exchange_rate must be greater than zero"):
        validate_position_entries([{
            "quantity": 1,
            "purchase_price": 10,
            "exchange_rate": invalid_exchange_rate,
            "exchange_rate_currency": "SEK",
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }])


@pytest.mark.parametrize("invalid_exchange_rate", [float("nan"), float("inf"), float("-inf")])
def test_normalize_position_entries_drops_non_finite_exchange_rate(invalid_exchange_rate):
    normalized = normalize_position_entries([{
        "quantity": 1,
        "purchase_price": 10,
        "exchange_rate": invalid_exchange_rate,
        "exchange_rate_currency": "SEK",
        "purchase_date": "2024-01-01",
        "sell_date": None,
    }])

    assert normalized[0]["exchange_rate"] is None
    assert normalized[0]["exchange_rate_currency"] is None


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


def test_calculate_position_cost_basis_handles_brokerage_in_target_currency_with_explicit_rate():
    total_cost = calculate_position_cost_basis(
        [{
            "quantity": 10,
            "purchase_price": 66.39,
            "courtage": 14.23,
            "courtage_currency": "SEK",
            "exchange_rate": 10.7148,
            "exchange_rate_currency": "SEK",
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }],
        "USD",
        "SEK",
        conversion_callback=lambda amount, from_currency, to_currency: None,
    )

    assert total_cost == pytest.approx(7127.78572)


def test_apply_stock_split_creates_post_split_lot_and_preserves_history():
    updated_entries = apply_stock_split(
        [{
            "quantity": 30,
            "purchase_price": 100,
            "courtage": 10,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }],
        5,
        "2024-06-01",
    )

    snapshot = calculate_position_snapshot(updated_entries)

    assert snapshot["quantity"] == pytest.approx(150)
    assert snapshot["purchase_price"] == pytest.approx((30 * 100 + 10) / 150)
    assert get_quantity_held_on_date(updated_entries, "2024-05-31") == pytest.approx(30)
    assert get_quantity_held_on_date(updated_entries, "2024-06-02") == pytest.approx(150)


def test_apply_stock_split_only_affects_lots_held_before_split_date():
    updated_entries = apply_stock_split(
        [{
            "quantity": 30,
            "purchase_price": 100,
            "purchase_date": "2024-01-01",
            "sell_date": None,
        }, {
            "quantity": 10,
            "purchase_price": 20,
            "purchase_date": "2024-06-01",
            "sell_date": None,
        }],
        5,
        "2024-06-01",
    )

    snapshot = calculate_position_snapshot(updated_entries)

    assert snapshot["quantity"] == pytest.approx(160)
    assert get_quantity_held_on_date(updated_entries, "2024-05-31") == pytest.approx(30)
    assert get_quantity_held_on_date(updated_entries, "2024-06-02") == pytest.approx(160)


def test_apply_stock_split_rejects_when_no_open_shares_exist_before_split_date():
    with pytest.raises(ValueError, match="No open shares held before split_date"):
        apply_stock_split(
            [{
                "quantity": 10,
                "purchase_price": 50,
                "purchase_date": "2024-06-01",
                "sell_date": None,
            }],
            5,
            "2024-06-01",
        )
