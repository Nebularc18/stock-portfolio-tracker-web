"""User settings API endpoints.

This module provides API endpoints for managing user preferences
such as display currency for the portfolio.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
import json

from app.main import get_db, get_current_user, User, UserSettings

router = APIRouter()

AVAILABLE_INDICES = [
    {"symbol": "^OMXS30", "name": "OMX Stockholm 30"},
    {"symbol": "^OMXS30GI", "name": "OMX Stockholm 30 GI"},
    {"symbol": "^OMXSPI", "name": "OMX Stockholm PI"},
    {"symbol": "^OMXC25", "name": "OMX Copenhagen 25"},
    {"symbol": "^OMXH25", "name": "OMX Helsinki 25"},
    {"symbol": "^OSEAX", "name": "Oslo All Share"},
    {"symbol": "^GSPC", "name": "S&P 500"},
    {"symbol": "^DJI", "name": "Dow Jones"},
    {"symbol": "^IXIC", "name": "NASDAQ"},
    {"symbol": "^FTSE", "name": "FTSE 100"},
    {"symbol": "^GDAXI", "name": "DAX"},
    {"symbol": "^STOXX50E", "name": "Euro Stoxx 50"},
]

VALID_INDEX_SYMBOLS = {idx["symbol"] for idx in AVAILABLE_INDICES}


class AvailableIndex(BaseModel):
    symbol: str
    name: str


class SettingsResponse(BaseModel):
    display_currency: str
    header_indices: List[str]

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    display_currency: Optional[str] = None
    header_indices: Optional[List[str]] = None


def parse_header_indices(header_indices_str: Optional[str]) -> List[str]:
    """Safely parse header_indices JSON string."""
    if not header_indices_str:
        return []
    try:
        parsed = json.loads(header_indices_str)
        if isinstance(parsed, list):
            return [str(s) for s in parsed if isinstance(s, str)]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


def get_or_create_settings(db: Session, user: User) -> UserSettings:
    """Retrieve user settings or create default settings if none exist.
    
    Args:
        db: Database session.
        user: Authenticated user whose settings should be fetched or created.
    
    Returns:
        UserSettings: The existing or newly created settings record.
    """
    settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
    if not settings:
        settings = UserSettings(user_id=user.id, display_currency="SEK", header_indices="[]")
        db.add(settings)
        try:
            db.commit()
            db.refresh(settings)
        except IntegrityError:
            db.rollback()
            settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
            if not settings:
                raise
            db.refresh(settings)
        except Exception:
            db.rollback()
            raise
    return settings


@router.get("", response_model=SettingsResponse)
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Retrieve user display preferences.
    
    Args:
        db: Database session dependency.
    
    Returns:
        SettingsResponse: Current display currency and header indices settings.
    """
    settings = get_or_create_settings(db, current_user)
    header_indices = parse_header_indices(settings.header_indices)
    return SettingsResponse(
        display_currency=settings.display_currency,
        header_indices=header_indices
    )


@router.get("/available-indices", response_model=List[AvailableIndex])
def get_available_indices():
    """Get list of all available market indices for header selection.
    
    Returns:
        List of available indices with symbol and name.
    """
    return [AvailableIndex(symbol=idx["symbol"], name=idx["name"]) for idx in AVAILABLE_INDICES]


@router.patch("", response_model=SettingsResponse)
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Update user display preferences.
    
    Args:
        data: Settings to update (display_currency, header_indices).
        db: Database session dependency.
    
    Returns:
        SettingsResponse: Updated settings.
    """
    settings = get_or_create_settings(db, current_user)
    
    if data.display_currency is not None:
        settings.display_currency = data.display_currency
    
    if data.header_indices is not None:
        seen = set()
        deduped_indices = []
        for s in data.header_indices:
            if s not in seen:
                seen.add(s)
                deduped_indices.append(s)
        valid_indices = [s for s in deduped_indices if s in VALID_INDEX_SYMBOLS]
        if len(valid_indices) != len(deduped_indices):
            invalid = sorted(set(deduped_indices) - VALID_INDEX_SYMBOLS)
            raise HTTPException(
                status_code=400,
                detail=f"Invalid index symbols: {', '.join(invalid)}"
            )
        settings.header_indices = json.dumps(valid_indices)
    
    db.commit()
    db.refresh(settings)
    
    header_indices = parse_header_indices(settings.header_indices)
    
    return SettingsResponse(
        display_currency=settings.display_currency,
        header_indices=header_indices
    )
