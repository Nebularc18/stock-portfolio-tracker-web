"""Brandfetch logo service.

This module resolves logo URLs using Brandfetch search endpoint and caches
the resulting icon URL by ticker.
"""

import json
import logging
import os
import re
from datetime import datetime
from typing import Optional
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

_LOGO_CACHE_TTL = 86400
_LOGO_CACHE: dict[str, tuple[Optional[str], float]] = {}

_session: Optional[requests.Session] = None


def _get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        })
    return _session


def _load_file_cache(filename: str) -> Optional[str]:
    filepath = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(filepath):
        return None

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if datetime.now().timestamp() - data.get('timestamp', 0) < data.get('ttl', _LOGO_CACHE_TTL):
            return data.get('value')
    except Exception as exc:
        logger.warning(f"Failed to load cache file {filename}: {exc}")

    return None


def _save_file_cache(filename: str, value: Optional[str], ttl: int = _LOGO_CACHE_TTL) -> None:
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump({'value': value, 'timestamp': datetime.now().timestamp(), 'ttl': ttl}, f)
    except Exception as exc:
        logger.warning(f"Failed to save cache file {filename}: {exc}")


class BrandfetchService:
    def _normalize_text(self, value: str) -> str:
        normalized = value.lower()
        normalized = re.sub(r"[^a-z0-9\s]", " ", normalized)
        normalized = re.sub(r"\b(corporation|corp|inc|ltd|plc|holding|holdings|group|ab|ag|nv|the|company)\b", " ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        return normalized

    def _token_set(self, value: str) -> set[str]:
        normalized = self._normalize_text(value)
        return {token for token in normalized.split(" ") if len(token) >= 3}

    def _is_confident_match(
        self,
        candidate: dict,
        ticker: str,
        company_name: Optional[str],
        query: str,
    ) -> bool:
        candidate_name = str(candidate.get('name') or '')
        candidate_domain = str(candidate.get('domain') or '')
        verified = bool(candidate.get('verified'))
        quality_score = float(candidate.get('qualityScore') or 0)

        expected_tokens: set[str] = set()
        if company_name and company_name.strip():
            expected_tokens |= self._token_set(company_name)

        ticker_base = ticker.upper().split('.', 1)[0].split('-', 1)[0]
        if ticker_base and ticker_base.isalpha() and len(ticker_base) >= 3:
            expected_tokens.add(ticker_base.lower())

        if not expected_tokens:
            expected_tokens |= self._token_set(query)

        candidate_tokens = self._token_set(candidate_name)
        domain_tokens = self._token_set(candidate_domain.replace('.', ' '))
        matched = expected_tokens.intersection(candidate_tokens.union(domain_tokens))
        match_ratio = (len(matched) / len(expected_tokens)) if expected_tokens else 0

        if match_ratio >= 0.6:
            return True

        if verified and quality_score >= 0.95 and match_ratio >= 0.4:
            return True

        return False

    def _build_query_candidates(self, ticker: str, company_name: Optional[str]) -> list[str]:
        candidates: list[str] = []

        if company_name and company_name.strip():
            clean_name = company_name.strip()
            candidates.append(clean_name)

            normalized = re.sub(r"\(.*?\)", "", clean_name)
            normalized = re.sub(r"\bser\.?\s+[A-Za-z]\b", "", normalized, flags=re.IGNORECASE)
            normalized = re.sub(r"\bclass\s+[A-Za-z]\b", "", normalized, flags=re.IGNORECASE)
            normalized = re.sub(r"\b(corporation|corp\.?|inc\.?|ltd\.?|plc|ag|nv)\b", "", normalized, flags=re.IGNORECASE)
            normalized = re.sub(r"\s+", " ", normalized.replace(',', ' ')).strip()
            if normalized and normalized != clean_name:
                candidates.append(normalized)

            ab_split = re.split(r"\bAB\b", normalized, flags=re.IGNORECASE)
            if ab_split:
                name_before_ab = ab_split[0].strip()
                if name_before_ab and name_before_ab != normalized:
                    candidates.append(name_before_ab)

        ticker_upper = ticker.upper().strip()
        if ticker_upper:
            candidates.append(ticker_upper)

            ticker_base = ticker_upper.split('.', 1)[0]
            if ticker_base and ticker_base != ticker_upper:
                candidates.append(ticker_base)

            if (not company_name or not company_name.strip()) and '-' in ticker_base:
                ticker_root = ticker_base.split('-', 1)[0]
                if ticker_root:
                    candidates.append(ticker_root)

        unique_candidates: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            if candidate and candidate not in seen:
                seen.add(candidate)
                unique_candidates.append(candidate)

        return unique_candidates

    def _search_logo(self, query: str, ticker: str, company_name: Optional[str]) -> Optional[str]:
        if not query:
            return None

        session = _get_session()
        url = f"https://api.brandfetch.io/v2/search/{quote(query)}"

        try:
            response = session.get(url, timeout=10)
            if response.status_code != 200:
                return None

            data = response.json()
            if not isinstance(data, list) or not data:
                return None

            for candidate in data:
                icon = candidate.get('icon') if isinstance(candidate, dict) else None
                if icon and isinstance(candidate, dict) and self._is_confident_match(candidate, ticker, company_name, query):
                    return icon
        except Exception as exc:
            logger.warning(f"Brandfetch search failed for '{query}': {exc}")

        return None

    def get_logo_url_for_ticker(
        self,
        ticker: str,
        company_name: Optional[str] = None,
        force_refresh: bool = False,
    ) -> Optional[str]:
        ticker_upper = ticker.upper()
        cache_file = f"brandfetch_logo_v2_{ticker_upper}.json"

        if not force_refresh and ticker_upper in _LOGO_CACHE:
            cached_logo, timestamp = _LOGO_CACHE[ticker_upper]
            if datetime.now().timestamp() - timestamp < _LOGO_CACHE_TTL:
                return cached_logo

        if not force_refresh:
            cached_logo = _load_file_cache(cache_file)
            if cached_logo is not None:
                _LOGO_CACHE[ticker_upper] = (cached_logo, datetime.now().timestamp())
                return cached_logo

        candidates = self._build_query_candidates(ticker_upper, company_name)

        logo_url = None
        for query in candidates:
            logo_url = self._search_logo(query, ticker_upper, company_name)
            if logo_url:
                break

        _LOGO_CACHE[ticker_upper] = (logo_url, datetime.now().timestamp())
        _save_file_cache(cache_file, logo_url)
        return logo_url


brandfetch_service = BrandfetchService()
