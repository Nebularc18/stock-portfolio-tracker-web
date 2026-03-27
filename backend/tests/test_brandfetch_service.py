import pytest

from app.services.brandfetch_service import BrandfetchService


@pytest.fixture
def brandfetch_service() -> BrandfetchService:
    """
    Pytest fixture that provides a fresh BrandfetchService instance for tests.
    
    Returns:
        BrandfetchService: A new BrandfetchService instance.
    """
    return BrandfetchService()


def test_build_query_candidates_includes_curated_eqt_domain(brandfetch_service: BrandfetchService):
    candidates = brandfetch_service._build_query_candidates("EQT.ST", "EQT AB")

    assert "eqtpartners.com" in candidates


def test_build_query_candidates_includes_curated_cibus_domain(brandfetch_service: BrandfetchService):
    candidates = brandfetch_service._build_query_candidates("CIBUS.ST", "Cibus Nordic Real Estate AB (publ)")

    assert "cibusrealestate.com" in candidates


def test_build_query_candidates_include_ticker_root_even_with_company_name(brandfetch_service: BrandfetchService):
    candidates = brandfetch_service._build_query_candidates("SEB-A.ST", "Skandinaviska Enskilda Banken AB")

    assert "SEB-A" in candidates
    assert "SEB" in candidates


def test_confident_match_accepts_curated_domain_for_single_token_name(brandfetch_service: BrandfetchService):
    candidate = {
        "name": "EQT Group",
        "domain": "eqtpartners.com",
        "verified": None,
        "qualityScore": 0.7104741968493185,
    }

    assert brandfetch_service._is_confident_match(candidate, "EQT.ST", "EQT AB", "eqtpartners.com") is True


def test_confident_match_rejects_ambiguous_single_token_without_curated_domain(brandfetch_service: BrandfetchService):
    candidate = {
        "name": "Equity Trustees",
        "domain": "eqt.com.au",
        "verified": True,
        "qualityScore": 0.7720297218535843,
    }

    assert brandfetch_service._is_confident_match(candidate, "EQT.ST", "EQT AB", "EQT") is False


def test_confident_match_rejects_same_root_different_host_for_curated_domain(brandfetch_service: BrandfetchService):
    candidate = {
        "name": "EQT Group",
        "domain": "eqt.net",
        "verified": None,
        "qualityScore": 0.91,
    }

    assert brandfetch_service._is_confident_match(candidate, "EQT.ST", "EQT AB", "eqt.com.au") is False


def test_get_logo_url_for_ticker_prefers_curated_local_logo(brandfetch_service: BrandfetchService):
    logo_url = brandfetch_service.get_logo_url_for_ticker(
        "CIBUS.ST",
        "Cibus Nordic Real Estate AB (publ)",
        existing_logo="/static/logos/logo_wrong.png",
    )

    assert logo_url == "/static/logos/cibus.svg"


def test_get_finnhub_logo_tries_base_and_root_ticker_variants(
    brandfetch_service: BrandfetchService,
    monkeypatch: pytest.MonkeyPatch,
):
    looked_up: list[str] = []

    class FinnhubStub:
        def clear_cache(self, ticker: str) -> None:
            pass

        def get_company_profile(self, ticker: str):
            looked_up.append(ticker)
            if ticker == "SEB":
                return {"logo": None, "website": "https://seb.se"}
            return None

    monkeypatch.setattr("app.services.brandfetch_service.finnhub_service", FinnhubStub())
    monkeypatch.setattr(
        brandfetch_service,
        "_persist_candidate_logo",
        lambda candidate, ticker: "/static/logos/seb.png" if candidate.get("domain") == "seb.se" else None,
    )

    logo_url = brandfetch_service._get_finnhub_logo("SEB-A.ST")

    assert logo_url == "/static/logos/seb.png"
    assert looked_up == ["SEB-A.ST", "SEB-A", "SEB"]
