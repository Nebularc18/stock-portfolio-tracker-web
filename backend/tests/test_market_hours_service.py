from datetime import datetime, timezone

from app.services.market_hours_service import MarketHoursService


def test_infer_market_for_ticker_uses_configured_suffixes():
    assert MarketHoursService.infer_market_for_ticker("VOLV-B.ST") == "SE"
    assert MarketHoursService.infer_market_for_ticker("MSFT") is None
    assert MarketHoursService.infer_market_for_ticker("MSFT", assume_unsuffixed_us=True) == "US"
    assert MarketHoursService.infer_market_for_ticker("SHOP.TO") is None
    assert MarketHoursService.infer_market_for_ticker("NESN.SW") is None


def test_should_refresh_for_swedish_market_only_during_open_and_one_interval_after_close():
    assert MarketHoursService.should_refresh(
        ["SE"],
        minutes_after_close=10,
        now=datetime(2026, 3, 26, 16, 30, tzinfo=timezone.utc),
    ) is True
    assert MarketHoursService.should_refresh(
        ["SE"],
        minutes_after_close=10,
        now=datetime(2026, 3, 26, 16, 40, tzinfo=timezone.utc),
    ) is False


def test_should_refresh_for_swedish_market_defaults_to_thirty_minutes_after_close():
    assert MarketHoursService.should_refresh(
        ["SE"],
        now=datetime(2026, 3, 26, 16, 50, tzinfo=timezone.utc),
    ) is True
    assert MarketHoursService.should_refresh(
        ["SE"],
        now=datetime(2026, 3, 26, 16, 56, tzinfo=timezone.utc),
    ) is False


def test_should_refresh_for_swedish_market_ten_minutes_before_open():
    assert MarketHoursService.should_refresh(
        ["SE"],
        minutes_before_open=10,
        now=datetime(2026, 3, 26, 7, 49, tzinfo=timezone.utc),
    ) is False
    assert MarketHoursService.should_refresh(
        ["SE"],
        minutes_before_open=10,
        now=datetime(2026, 3, 26, 7, 50, tzinfo=timezone.utc),
    ) is True
    assert MarketHoursService.should_refresh(
        ["SE"],
        minutes_before_open=10,
        now=datetime(2026, 3, 26, 7, 59, tzinfo=timezone.utc),
    ) is True


def test_should_refresh_for_swedish_market_defaults_to_thirty_minutes_before_open():
    assert MarketHoursService.should_refresh(
        ["SE"],
        now=datetime(2026, 3, 26, 7, 29, tzinfo=timezone.utc),
    ) is False
    assert MarketHoursService.should_refresh(
        ["SE"],
        now=datetime(2026, 3, 26, 7, 30, tzinfo=timezone.utc),
    ) is True
    assert MarketHoursService.should_refresh(
        ["SE"],
        now=datetime(2026, 3, 26, 7, 59, tzinfo=timezone.utc),
    ) is True


def test_should_refresh_for_us_market_ten_minutes_before_open():
    assert MarketHoursService.should_refresh(
        ["US"],
        minutes_before_open=10,
        now=datetime(2026, 3, 26, 13, 19, tzinfo=timezone.utc),
    ) is False
    assert MarketHoursService.should_refresh(
        ["US"],
        minutes_before_open=10,
        now=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
    ) is True


def test_should_refresh_when_any_held_market_is_still_open():
    assert MarketHoursService.should_refresh(
        ["SE", "US"],
        minutes_after_close=10,
        now=datetime(2026, 3, 26, 18, 0, tzinfo=timezone.utc),
    ) is True
