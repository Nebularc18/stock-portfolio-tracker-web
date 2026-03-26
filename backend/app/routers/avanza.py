from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import logging
from sqlalchemy.orm import Session

from app.services.avanza_service import avanza_service
from app.main import User, get_current_user, get_db

router = APIRouter()
logger = logging.getLogger(__name__)


class TickerMappingCreate(BaseModel):
    avanza_name: str
    yahoo_ticker: str
    instrument_id: str


class TickerMappingResponse(BaseModel):
    avanza_name: str
    yahoo_ticker: str
    instrument_id: Optional[str]
    manually_added: bool


class DividendResponse(BaseModel):
    avanza_name: str
    yahoo_ticker: Optional[str]
    ex_date: str
    amount: float
    currency: str
    payment_date: Optional[str]
    dividend_type: Optional[str]


@router.get("/dividends")
def get_avanza_dividends():
    """
    Fetch upcoming dividends for mapped Swedish stocks.
    
    Returns:
        list: Each item is a dict with keys:
            - avanza_name (str)
            - yahoo_ticker (Optional[str])
            - ex_date (str)
            - amount (float)
            - currency (str)
            - payment_date (Optional[str])
            - dividend_type (Optional[str])
            - instrument_id (Optional[str])
    """
    dividends = avanza_service.fetch_upcoming_dividends()
    return [{
        'avanza_name': d.avanza_name,
        'yahoo_ticker': d.yahoo_ticker,
        'ex_date': d.ex_date,
        'amount': d.amount,
        'currency': d.currency,
        'payment_date': d.payment_date,
        'dividend_type': d.dividend_type,
        'instrument_id': d.instrument_id
    } for d in dividends]


@router.get("/mappings")
def get_all_mappings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Retrieve ticker mappings relevant to the current user's stocks.

    Returns:
        list: A list of mapping objects where each item contains `avanza_name`, `yahoo_ticker`, `instrument_id` (or `None`), and `manually_added` (bool).
    """
    mappings = avanza_service.get_relevant_mappings_for_user(current_user.id)
    return [{
        'avanza_name': m.avanza_name,
        'yahoo_ticker': m.yahoo_ticker,
        'instrument_id': m.instrument_id,
        'manually_added': m.manually_added,
        'added_at': m.added_at,
    } for m in mappings]


@router.post("/mappings")
def add_mapping(mapping: TickerMappingCreate, current_user: User = Depends(get_current_user)):
    """
    Create and persist a manual ticker mapping for an Avanza instrument.
    
    Parameters:
        mapping (TickerMappingCreate): Mapping containing `avanza_name`, `yahoo_ticker`, and `instrument_id`.
    
    Returns:
        dict: Created mapping with keys `avanza_name`, `yahoo_ticker`, `instrument_id`, and `manually_added` set to `True`.
    """
    try:
        created = avanza_service.add_manual_mapping(
            avanza_name=mapping.avanza_name,
            yahoo_ticker=mapping.yahoo_ticker,
            instrument_id=mapping.instrument_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        'avanza_name': created.avanza_name,
        'yahoo_ticker': created.yahoo_ticker,
        'instrument_id': created.instrument_id,
        'manually_added': created.manually_added,
        'added_at': created.added_at,
    }


@router.delete("/mappings/{avanza_name}")
def delete_mapping(avanza_name: str, current_user: User = Depends(get_current_user)):
    """
    Remove a ticker mapping identified by an Avanza stock name.
    
    Parameters:
        avanza_name (str): Avanza stock name used to locate the mapping (lookup is case-insensitive).
    
    Returns:
        dict: Confirmation message containing a 'message' key.
    
    Raises:
        HTTPException: 404 if the mapping for the provided name does not exist.
    """
    deleted = avanza_service.delete_mapping(avanza_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Mapping not found")

    return {'message': 'Mapping deleted'}


@router.get("/historical/{ticker}")
def get_historical_dividends(ticker: str, years: int = 5):
    """
    Retrieve historical dividend records for a Swedish stock ticker.
    
    Parameters:
    	ticker (str): Yahoo Finance ticker; must end with ".ST".
    	years (int): Number of past years to include.
    
    Returns:
    	list: A list of dividend records (dict-like objects) for the ticker, each containing fields such as ex-date, amount, currency, and optionally payment date and dividend type.
    """
    if not ticker.upper().endswith('.ST'):
        raise HTTPException(status_code=400, detail="Only Swedish stocks (.ST) are supported")
    
    dividends = avanza_service.get_historical_dividends(ticker, years)
    return dividends


@router.get("/stock/{instrument_id}")
def get_stock_info(instrument_id: str):
    """
    Retrieve stock metadata and dividend information for a given Avanza instrument ID.
    
    Parameters:
        instrument_id (str): The Avanza instrument ID to fetch.
    
    Returns:
        dict: Stock information with keys:
            - name (str|None): Stock name.
            - ticker (str|None): Listing ticker symbol.
            - isin (str|None): ISIN identifier.
            - currency (str|None): Listing currency.
            - upcoming_dividends (list): Upcoming dividend events.
            - past_dividends (list): Past dividend events (at most 10 items).
    
    Raises:
        HTTPException: 404 if the instrument is not found.
    """
    data = avanza_service._fetch_stock_data(instrument_id)
    
    if not data:
        raise HTTPException(status_code=404, detail="Stock not found")
    
    stock_data = data.get('data', {})
    data_details = data.get('dataDetails', {})
    dividends = data_details.get('dividends', {})
    
    return {
        'name': stock_data.get('name'),
        'ticker': stock_data.get('listing', {}).get('tickerSymbol'),
        'isin': stock_data.get('isin'),
        'currency': stock_data.get('listing', {}).get('currency'),
        'upcoming_dividends': dividends.get('events', []),
        'past_dividends': dividends.get('pastEvents', [])[:10]
    }
