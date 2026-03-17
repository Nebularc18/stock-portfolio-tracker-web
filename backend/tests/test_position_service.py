import pytest

from app.services.position_service import normalize_position_entries, validate_position_entries


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
