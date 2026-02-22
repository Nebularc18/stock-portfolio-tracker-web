from fastapi import APIRouter, HTTPException
from typing import Optional, Dict, Any, List

from app.services.finnhub_service import finnhub_service

router = APIRouter()


@router.get("/profile/{ticker}")
def get_company_profile(ticker: str) -> Optional[Dict[str, Any]]:
    profile = finnhub_service.get_company_profile(ticker)
    if profile is None:
        raise HTTPException(status_code=404, detail="Company profile not found")
    return profile


@router.get("/metrics/{ticker}")
def get_financial_metrics(ticker: str) -> Optional[Dict[str, Any]]:
    metrics = finnhub_service.get_basic_financials(ticker)
    if metrics is None:
        raise HTTPException(status_code=404, detail="Financial metrics not found")
    return metrics


@router.get("/peers/{ticker}")
def get_peers(ticker: str) -> Optional[List[str]]:
    peers = finnhub_service.get_peers(ticker)
    if peers is None:
        raise HTTPException(status_code=404, detail="Peer companies not found")
    return peers


@router.get("/recommendations/{ticker}")
def get_recommendations(ticker: str) -> Optional[List[Dict[str, Any]]]:
    recommendations = finnhub_service.get_recommendation_trends(ticker)
    if recommendations is None:
        raise HTTPException(status_code=404, detail="Recommendations not found")
    return recommendations
