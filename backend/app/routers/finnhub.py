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
    
    Raises:
        HTTPException: 404 if profile not found.
    """
    profile = finnhub_service.get_company_profile(ticker)
    if profile is None:
        raise HTTPException(status_code=404, detail="Company profile not found")
    return profile


@router.get("/metrics/{ticker}")
def get_financial_metrics(ticker: str) -> Optional[Dict[str, Any]]:
    """Retrieve financial metrics for a company from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        dict: Financial metrics (P/E, revenue, margins, etc.).
    
    Raises:
        HTTPException: 404 if metrics not found.
    """
    metrics = finnhub_service.get_basic_financials(ticker)
    if metrics is None:
        raise HTTPException(status_code=404, detail="Financial metrics not found")
    return metrics


@router.get("/peers/{ticker}")
def get_peers(ticker: str) -> Optional[List[str]]:
    """Retrieve peer companies for a stock from Finnhub.
    
    Args:
        ticker: Stock ticker symbol.
    
    Returns:
        list: List of peer company ticker symbols.
    
    Raises:
        HTTPException: 404 if peers not found.
    """
    peers = finnhub_service.get_peers(ticker)
    if peers is None:
        raise HTTPException(status_code=404, detail="Peer companies not found")
    return peers


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
