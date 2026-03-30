import pytest

import app.services.brandfetch_service as brandfetch_module
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


def test_website_domain_candidates_include_curated_swedish_domain(
    brandfetch_service: BrandfetchService,
    monkeypatch: pytest.MonkeyPatch,
):
    class FinnhubStub:
        def get_company_profile(self, _ticker: str):
            return None

    monkeypatch.setattr("app.services.brandfetch_service.finnhub_service", FinnhubStub())

    candidates = brandfetch_service._website_domain_candidates("HM-B.ST", "Hennes & Mauritz AB")

    assert candidates[0] == "hmgroup.com"


def test_website_domain_candidates_include_curated_query_domain_without_company_name(
    brandfetch_service: BrandfetchService,
    monkeypatch: pytest.MonkeyPatch,
):
    class FinnhubStub:
        def get_company_profile(self, _ticker: str):
            return None

    monkeypatch.setattr("app.services.brandfetch_service.finnhub_service", FinnhubStub())

    candidates = brandfetch_service._website_domain_candidates("EQT.ST", None)

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


def test_extract_icon_candidates_from_html_prefers_site_icons(brandfetch_service: BrandfetchService):
    html = """
    <html>
      <head>
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">
        <link rel="icon" href="https://cdn.example.com/favicon-32x32.png">
        <meta property="og:image" content="/social-card.png">
      </head>
    </html>
    """

    candidates = brandfetch_service._extract_icon_candidates_from_html(html, "https://example.com/investors")

    assert candidates == [
        "https://example.com/apple-touch-icon.png",
        "https://cdn.example.com/favicon-32x32.png",
        "https://example.com/social-card.png",
    ]


def test_is_allowed_domain_logo_url_rejects_nested_subdomains(brandfetch_service: BrandfetchService):
    assert brandfetch_service._is_allowed_domain_logo_url("https://cdn.example.com/logo.png", {"example.com"}) is True
    assert brandfetch_service._is_allowed_domain_logo_url("https://a.b.example.com/logo.png", {"example.com"}) is False


def test_get_logo_url_for_ticker_prefers_website_logo_before_search(
    brandfetch_service: BrandfetchService,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(brandfetch_service, "_curated_local_logo_path", lambda _ticker: None)
    monkeypatch.setattr(brandfetch_service, "_website_domain_candidates", lambda *_args, **_kwargs: ["sebgroup.com"])
    monkeypatch.setattr(brandfetch_service, "_persist_website_logo", lambda domain, _ticker: "/static/logos/seb-site.png" if domain == "sebgroup.com" else None)
    monkeypatch.setattr(brandfetch_service, "_get_finnhub_logo", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("finnhub fallback should not run")))
    monkeypatch.setattr(brandfetch_service, "_search_logo", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("brandfetch search should not run")))

    logo_url = brandfetch_service.get_logo_url_for_ticker("SEB-A.ST", "Skandinaviska Enskilda Banken AB", force_refresh=True)

    assert logo_url == "/static/logos/seb-site.png"


def test_get_logo_url_for_ticker_uses_shorter_negative_cache_ttl(
    brandfetch_service: BrandfetchService,
    monkeypatch: pytest.MonkeyPatch,
):
    saved_entries: list[tuple[str, object, int]] = []

    monkeypatch.setattr(brandfetch_service, "_curated_local_logo_path", lambda _ticker: None)
    monkeypatch.setattr(brandfetch_service, "_website_domain_candidates", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(brandfetch_service, "_get_finnhub_logo", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(brandfetch_service, "_build_query_candidates", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(brandfetch_module, "_save_file_cache", lambda filename, value, ttl=brandfetch_module._LOGO_CACHE_TTL: saved_entries.append((filename, value, ttl)))

    logo_url = brandfetch_service.get_logo_url_for_ticker("MILDEF.ST", "MilDef Group AB", force_refresh=True)

    assert logo_url is None
    assert saved_entries
    assert saved_entries[-1][2] == brandfetch_module._NEGATIVE_LOGO_CACHE_TTL
