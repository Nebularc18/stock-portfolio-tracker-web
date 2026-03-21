import pytest

from app.services.brandfetch_service import BrandfetchService


@pytest.fixture
def brandfetch_service() -> BrandfetchService:
    return BrandfetchService()


def test_build_query_candidates_includes_curated_eqt_domain(brandfetch_service: BrandfetchService):
    candidates = brandfetch_service._build_query_candidates("EQT.ST", "EQT AB")

    assert "eqtpartners.com" in candidates


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
