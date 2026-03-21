from app.services.brandfetch_service import BrandfetchService


def test_build_query_candidates_includes_curated_eqt_domain():
    service = BrandfetchService()

    candidates = service._build_query_candidates("EQT.ST", "EQT AB")

    assert "eqtpartners.com" in candidates


def test_confident_match_accepts_curated_domain_for_single_token_name():
    service = BrandfetchService()

    candidate = {
        "name": "EQT Group",
        "domain": "eqtpartners.com",
        "verified": None,
        "qualityScore": 0.7104741968493185,
    }

    assert service._is_confident_match(candidate, "EQT.ST", "EQT AB", "eqtpartners.com") is True


def test_confident_match_rejects_ambiguous_single_token_without_curated_domain():
    service = BrandfetchService()

    candidate = {
        "name": "Equity Trustees",
        "domain": "eqt.com.au",
        "verified": True,
        "qualityScore": 0.7720297218535843,
    }

    assert service._is_confident_match(candidate, "EQT.ST", "EQT AB", "EQT") is False
