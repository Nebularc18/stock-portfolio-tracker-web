"""User settings API endpoints.

This module provides API endpoints for managing user preferences
such as display currency for the portfolio.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy.orm import Session
import json

from app.main import get_db, UserSettings

router = APIRouter()

AVAILABLE_INDICES = [
    {"symbol": "^OMXS30", "name": "OMX Stockholm 30"},
    {"symbol": "^OMXS30GI", "name": "OMX Stockholm 30 GI"},
    {"symbol": "^OMXSPI", "name": "OMX Stockholm PI"},
    {"symbol": "^OMXC25", "name": "OMX Copenhagen 25"},
    {"symbol": "^OMXH25", "name": "OMX Helsinki 25"},
    {"symbol": "^GSPC", "name": "S&P 500"},
    {"symbol": "^IXIC", "name": "NASDAQ"},
    {"symbol": "^FTSE", "name": "FTSE 100"},
    {"symbol": "^GDAXI", "name": "DAX"},
    {"symbol": "^STOXX50E", "name": "Euro Stoxx 50"},
]


class SettingsResponse(BaseModel):
    display_currency: str
    header_indices: List[str]

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    display_currency: Optional[str] = None
    header_indices: Optional[List[str]] = None


def get_or_create_settings(db: Session) -> UserSettings:
    """Retrieve user settings or create default settings if none exist.
    
    Args:
        db: Database session.
    
    Returns:
        UserSettings: The existing or newly created settings record.
    """
    settings = db.query(UserSettings).first()
    if not settings:
        settings = UserSettings(display_currency="SEK", header_indices="[]")
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("", response_model=SettingsResponse)
def get_settings(db: Session = Depends(get_db)):
    """Retrieve user display preferences.
    
    Args:
        db: Database session dependency.
    
    Returns:
        SettingsResponse: Current display currency and header indices settings.
    """
    settings = get_or_create_settings(db)
    try:
        header_indices = json.loads(settings.header_indices) if settings.header_indices else []
    except:
        header_indices = []
    return SettingsResponse(
        display_currency=settings.display_currency,
        header_indices=header_indices
    )


@router.get("/available-indices")
def get_available_indices():
    """Get list of all available market indices for header selection.
    
    Returns:
        List of available indices with symbol and name.
    """
    return AVAILABLE_INDICES


@router.patch("", response_model=SettingsResponse)
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db)):
    """Update user display preferences.
    
    Args:
        data: Settings to update (display_currency, header_indices).
        db: Database session dependency.
    
    Returns:
        SettingsResponse: Updated settings.
    """
    settings = get_or_create_settings(db)
    
    if data.display_currency is not None:
        settings.display_currency = data.display_currency
    
    if data.header_indices is not None:
        settings.header_indices = json.dumps(data.header_indices)
    
    db.commit()
    db.refresh(settings)
    
    try:
        header_indices = json.loads(settings.header_indices) if settings.header_indices else []
    except:
        header_indices = []
    
    return SettingsResponse(
        display_currency=settings.display_currency,
        header_indices=header_indices
    )
