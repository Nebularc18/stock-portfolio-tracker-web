"""Finnhub API proxy endpoints.

This module provides API endpoints that proxy requests to the Finnhub
API for company profiles, financial metrics, peer companies, and
analyst recommendations.
"""

from fastapi import APIRouter, HTTPException
from typing import Optional, Dict, Any, List

from app.services.finnhub_service import finnhub_service

router = APIRouter()


@router.get("/profile/{ticker}")
def get_company_profile(ticker: str) -> Optional[Dict[str, Any]]:
    """Retrieve company profile information from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        dict: Company profile data (name, industry, country, etc.).
    
    """
    return finnhub_service.get_company_profile(ticker)


@router.get("/metrics/{ticker}")
def get_financial_metrics(ticker: str) -> Optional[Dict[str, Any]]:
    """Retrieve financial metrics for a company from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        dict: Financial metrics (P/E, revenue, margins, etc.).
    
    """
    return finnhub_service.get_basic_financials(ticker)


@router.get("/peers/{ticker}")
def get_peers(ticker: str) -> Optional[List[str]]:
    """Retrieve peer companies for a stock from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        list: List of peer company ticker symbols.
    
    """
    peers = finnhub_service.get_peers(ticker)
    return peers if peers is not None else []


@router.get("/recommendations/{ticker}")
def get_recommendations(ticker: str) -> Optional[List[Dict[str, Any]]]:
    """Retrieve analyst recommendation trends from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        list: List of recommendation trends with buy/sell/hold counts.
    
    Raises:
        HTTPException: 404 if recommendations not found.
    """
    recommendations = finnhub_service.get_recommendation_trends(ticker)
    if recommendations is None:
        raise HTTPException(status_code=404, detail="Recommendations not found")
    return recommendations
