"""User settings API endpoints.

This module provides API endpoints for managing user preferences
such as display currency for the portfolio.
"""

from fastapi import APIRouter, Depends, HTTPException
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
    """
    Parse a JSON-encoded list of index symbols from a stored header_indices value.
    
    Parameters:
        header_indices_str (Optional[str]): JSON string expected to represent a list of index symbol strings (e.g. '["OMXS30","DJI"]'). May be None or empty.
    
    Returns:
        List[str]: List of parsed symbol strings. Returns an empty list if input is None/empty, not a JSON list, contains no string elements, or if parsing fails.
    """
    if not header_indices_str:
        return []
    try:
        parsed = json.loads(header_indices_str)
        if isinstance(parsed, list):
            return [str(s) for s in parsed if isinstance(s, str)]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


def get_or_create_settings(db: Session) -> UserSettings:
    """
    Retrieve the user's settings record, creating and persisting a default settings record with display_currency="SEK" and empty header_indices if none exists.
    
    Returns:
        The existing or newly created UserSettings instance.
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
    """
    Get current user display currency and parsed header indices.
    
    Returns:
        SettingsResponse: The current display currency and a list of header index symbols parsed from storage.
    """
    settings = get_or_create_settings(db)
    header_indices = parse_header_indices(settings.header_indices)
    return SettingsResponse(
        display_currency=settings.display_currency,
        header_indices=header_indices
    )


@router.get("/available-indices", response_model=List[AvailableIndex])
def get_available_indices():
    """
    Return the available market indices for header selection.
    
    Returns:
        List[AvailableIndex]: A list of AvailableIndex instances, each containing `symbol` and `name`.
    """
    return [AvailableIndex(symbol=idx["symbol"], name=idx["name"]) for idx in AVAILABLE_INDICES]


@router.patch("", response_model=SettingsResponse)
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db)):
    """
    Update the current user's display preferences.
    
    Updates the stored display currency and/or header index selection, validating and normalizing provided indices before persisting.
    
    Parameters:
        data (SettingsUpdate): Fields to update. If `header_indices` is provided it will be deduplicated (preserving order) and validated against available index symbols.
        db (Session): Database session dependency.
    
    Returns:
        SettingsResponse: The updated settings with `display_currency` and a parsed `header_indices` list.
    
    Raises:
        HTTPException: If any provided header index symbols are invalid (status 400).
    """
    settings = get_or_create_settings(db)
    
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
            invalid = set(deduped_indices) - VALID_INDEX_SYMBOLS
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
