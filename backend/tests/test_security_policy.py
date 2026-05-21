from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app, get_current_user, require_admin_user, require_non_guest_user
from app.routers import market


@pytest.fixture()
def client():
    app.dependency_overrides.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user):
    app.dependency_overrides[get_current_user] = lambda: user


def test_provider_routes_require_authentication(client):
    response = client.get("/api/finnhub/profile/AAPL")

    assert response.status_code == 401


def test_guest_accounts_are_read_only(client):
    _override_user(SimpleNamespace(id=2, username="guest", is_guest=True))

    response = client.post("/api/stocks", json={})

    assert response.status_code == 403
    assert response.json()["detail"] == "Guest accounts are read-only"


def test_non_admin_cannot_mutate_shared_avanza_mappings(client, monkeypatch):
    monkeypatch.setenv("DEFAULT_USERNAME", "admin")
    _override_user(SimpleNamespace(id=3, username="alice", is_guest=False))

    response = client.post(
        "/api/avanza/mappings",
        json={
            "avanza_name": "Volvo B",
            "yahoo_ticker": "VOLV-B.ST",
            "instrument_id": "145016",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Admin privileges required"


def test_non_admin_cannot_force_market_header_refresh(client, monkeypatch):
    monkeypatch.setenv("DEFAULT_USERNAME", "admin")
    _override_user(SimpleNamespace(id=3, username="alice", is_guest=False))

    response = client.get("/api/market/header?force=true")

    assert response.status_code == 403
    assert response.json()["detail"] == "Admin privileges required to force refresh market data"


def test_require_non_guest_user_rejects_guest():
    with pytest.raises(HTTPException) as exc_info:
        require_non_guest_user(SimpleNamespace(id=2, username="guest", is_guest=True))

    assert exc_info.value.status_code == 403


def test_require_admin_user_accepts_configured_admin(monkeypatch):
    monkeypatch.setenv("DEFAULT_USERNAME", "admin")

    user = require_admin_user(SimpleNamespace(id=1, username="admin", is_guest=False))

    assert user.username == "admin"


def test_require_admin_user_reports_missing_admin_configuration(monkeypatch):
    monkeypatch.delenv("DEFAULT_USERNAME", raising=False)

    with pytest.raises(HTTPException) as exc_info:
        require_admin_user(SimpleNamespace(id=1, username="admin", is_guest=False))

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Admin user is not configured"


def test_guest_cannot_read_market_exchange_rates(client):
    _override_user(SimpleNamespace(id=2, username="guest", is_guest=True))

    response = client.get("/api/market/exchange-rates")

    assert response.status_code == 403
    assert response.json()["detail"] == "Guest accounts are read-only"


def test_exchange_rate_batch_rejects_too_many_dates():
    payload = market.ExchangeRatesBatchRequest(
        dates=["2026-01-01"] * (market.MAX_EXCHANGE_RATE_BATCH_DATES + 1),
    )

    with pytest.raises(HTTPException) as exc_info:
        market.get_exchange_rates_batch(
            payload=payload,
            _current_user=SimpleNamespace(id=1, username="admin", is_guest=False),
        )

    assert exc_info.value.status_code == 400
    assert "dates must contain at most" in exc_info.value.detail


def test_index_history_rejects_excessive_start_date(monkeypatch):
    monkeypatch.setattr(market, "MAX_INDEX_HISTORY_SPAN_DAYS", 30)

    with pytest.raises(HTTPException) as exc_info:
        market._resolve_index_history_window("all", "2025-01-01")

    assert exc_info.value.status_code == 400
    assert "index history range must not exceed" in exc_info.value.detail
