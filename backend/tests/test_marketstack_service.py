"""Unit tests for the Marketstack service.

This module contains tests for the MarketstackService class, including
tests for API configuration, usage tracking, dividend fetching, and
dividend verification functionality.
"""

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from app.services.marketstack_service import (
    MarketstackService,
    DividendData,
    VerificationResult,
    get_remaining_calls,
    _load_usage,
    _save_usage,
    MONTHLY_CALL_LIMIT,
)


class TestMarketstackService:
    """Test suite for MarketstackService."""
    
    def test_is_configured_returns_false_without_key(self):
        """Test that is_configured returns False when API key is not set."""
        with patch.dict('os.environ', {}, clear=True):
            service = MarketstackService()
            assert service.is_configured() is False
    
    def test_is_configured_returns_true_with_key(self):
        """Test that is_configured returns True when API key is set."""
        with patch.dict('os.environ', {'MARKETSTACK_API_KEY': 'test_key'}):
            service = MarketstackService()
            assert service.is_configured() is True
    
    def test_get_usage_status_new_month(self, tmp_path):
        """Test that usage status returns zero calls for a new month."""
        with patch('app.services.marketstack_service.CACHE_DIR', str(tmp_path)):
            service = MarketstackService()
            month_before = datetime.now().strftime('%Y-%m')
            status = service.get_usage_status()
            month_after = datetime.now().strftime('%Y-%m')
            
            assert status['calls_used'] == 0
            assert status['calls_limit'] == MONTHLY_CALL_LIMIT
            assert status['calls_remaining'] == MONTHLY_CALL_LIMIT
            assert status['month'] in {month_before, month_after}
    
    def test_dividend_data_creation(self):
        """Test DividendData dataclass creation with all fields."""
        div = DividendData(date='2024-01-15', amount=0.25, currency='USD')
        assert div.date == '2024-01-15'
        assert div.amount == 0.25
        assert div.currency == 'USD'
    
    def test_verification_result_creation(self):
        """Test VerificationResult dataclass creation."""
        result = VerificationResult(
            ticker='AAPL',
            yahoo_dividends=[{'date': '2024-01-15', 'amount': 0.25}],
            marketstack_dividends=[{'date': '2024-01-15', 'amount': 0.25}],
            discrepancies=[],
            verified_at='2024-01-20T00:00:00+00:00',
            yahoo_count=1,
            marketstack_count=1,
            match_count=1,
            discrepancy_count=0,
            calls_used=1
        )
        
        assert result.ticker == 'AAPL'
        assert result.match_count == 1
        assert result.discrepancy_count == 0
        assert result.cached is False
    
    def test_verify_dividends_detects_match(self, tmp_path):
        """Test that verify_dividends correctly identifies matching dividends."""
        with patch('app.services.marketstack_service.CACHE_DIR', str(tmp_path)):
            with patch.dict('os.environ', {'MARKETSTACK_API_KEY': 'test_key'}):
                service = MarketstackService()
                
                yahoo_dividends = [
                    {'date': '2024-01-15', 'amount': 0.25},
                    {'date': '2024-02-15', 'amount': 0.25}
                ]
                
                with patch.object(service, 'fetch_dividends') as mock_fetch:
                    mock_fetch.return_value = [
                        DividendData(date='2024-01-15', amount=0.25),
                        DividendData(date='2024-02-15', amount=0.25)
                    ]
                    
                    result = service.verify_dividends('AAPL', yahoo_dividends, use_cache=False)
                    
                    assert result.match_count == 2
                    assert result.discrepancy_count == 0
    
    def test_verify_dividends_detects_amount_mismatch(self, tmp_path):
        """Test that verify_dividends detects amount mismatches."""
        with patch('app.services.marketstack_service.CACHE_DIR', str(tmp_path)):
            with patch.dict('os.environ', {'MARKETSTACK_API_KEY': 'test_key'}):
                service = MarketstackService()
                
                yahoo_dividends = [
                    {'date': '2024-01-15', 'amount': 0.25}
                ]
                
                with patch.object(service, 'fetch_dividends') as mock_fetch:
                    mock_fetch.return_value = [
                        DividendData(date='2024-01-15', amount=0.30)
                    ]
                    
                    result = service.verify_dividends('AAPL', yahoo_dividends, use_cache=False)
                    
                    assert result.match_count == 0
                    assert result.discrepancy_count == 1
                    assert result.discrepancies[0]['type'] == 'amount_mismatch'
    
    def test_verify_dividends_detects_missing_from_marketstack(self, tmp_path):
        """Test that verify_dividends detects dividends missing from Marketstack."""
        with patch('app.services.marketstack_service.CACHE_DIR', str(tmp_path)):
            with patch.dict('os.environ', {'MARKETSTACK_API_KEY': 'test_key'}):
                service = MarketstackService()
                
                yahoo_dividends = [
                    {'date': '2024-01-15', 'amount': 0.25}
                ]
                
                with patch.object(service, 'fetch_dividends') as mock_fetch:
                    mock_fetch.return_value = []
                    
                    result = service.verify_dividends('AAPL', yahoo_dividends, use_cache=False)
                    
                    assert result.match_count == 0
                    assert result.discrepancy_count == 1
                    assert result.discrepancies[0]['type'] == 'missing_from_marketstack'
    
    def test_verify_dividends_detects_missing_from_yahoo(self, tmp_path):
        """Test that verify_dividends detects dividends missing from Yahoo."""
        with patch('app.services.marketstack_service.CACHE_DIR', str(tmp_path)):
            with patch.dict('os.environ', {'MARKETSTACK_API_KEY': 'test_key'}):
                service = MarketstackService()
                
                yahoo_dividends = []
                
                with patch.object(service, 'fetch_dividends') as mock_fetch:
                    mock_fetch.return_value = [
                        DividendData(date='2024-01-15', amount=0.25)
                    ]
                    
                    result = service.verify_dividends('AAPL', yahoo_dividends, use_cache=False)
                    
                    assert result.match_count == 0
                    assert result.discrepancy_count == 1
                    assert result.discrepancies[0]['type'] == 'missing_from_yahoo'
