from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from app.main import get_db, UserSettings

router = APIRouter()


class SettingsResponse(BaseModel):
    display_currency: str

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    display_currency: Optional[str] = None


def get_or_create_settings(db: Session) -> UserSettings:
    settings = db.query(UserSettings).first()
    if not settings:
        settings = UserSettings(display_currency="SEK")
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("", response_model=SettingsResponse)
def get_settings(db: Session = Depends(get_db)):
    settings = get_or_create_settings(db)
    return SettingsResponse(display_currency=settings.display_currency)


@router.patch("", response_model=SettingsResponse)
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db)):
    settings = get_or_create_settings(db)
    
    if data.display_currency is not None:
        settings.display_currency = data.display_currency
    
    db.commit()
    db.refresh(settings)
    return SettingsResponse(display_currency=settings.display_currency)
