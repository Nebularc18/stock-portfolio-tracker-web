from datetime import datetime, timezone

import pytest

from app.utils.time import floor_datetime_to_interval


def test_floor_datetime_to_interval_preserves_expected_scheduler_bucket():
    value = datetime(2026, 3, 26, 7, 59, 30, 123, tzinfo=timezone.utc)

    assert floor_datetime_to_interval(value, 10) == datetime(2026, 3, 26, 7, 50, tzinfo=timezone.utc)


def test_floor_datetime_to_interval_rejects_invalid_interval():
    with pytest.raises(ValueError):
        floor_datetime_to_interval(datetime(2026, 3, 26, tzinfo=timezone.utc), 0)
