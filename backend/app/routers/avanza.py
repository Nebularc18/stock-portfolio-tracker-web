from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import logging

from app.services.avanza_service import avanza_service

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
    """Fetch upcoming dividends for mapped Swedish stocks.
    
    Returns:
        list: List of upcoming dividends from aktieutdelningar.now.sh.
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
def get_all_mappings():
    """Get all ticker mappings.
    
    Returns:
        list: List of all ticker mappings (yahoo_ticker -> avanza_id).
    """
    return [{
        'avanza_name': m.avanza_name,
        'yahoo_ticker': m.yahoo_ticker,
        'instrument_id': m.instrument_id,
        'manually_added': m.manually_added
    } for m in avanza_service.mapping.values()]


@router.post("/mappings")
def add_mapping(mapping: TickerMappingCreate):
    """Add a ticker mapping.
    
    Args:
        mapping: The mapping to add (avanza_name, yahoo_ticker, instrument_id).
    
    Returns:
        dict: The created mapping.
    """
    avanza_service.add_manual_mapping(
        avanza_name=mapping.avanza_name,
        yahoo_ticker=mapping.yahoo_ticker,
        instrument_id=mapping.instrument_id
    )
    return {
        'avanza_name': mapping.avanza_name,
        'yahoo_ticker': mapping.yahoo_ticker,
        'instrument_id': mapping.instrument_id,
        'manually_added': True
    }


@router.delete("/mappings/{avanza_name}")
def delete_mapping(avanza_name: str):
    """Delete a ticker mapping.
    
    Args:
        avanza_name: The Avanza stock name to remove mapping for.
    
    Returns:
        dict: Confirmation message.
    """
    key = avanza_name.lower()
    if key not in avanza_service.mapping:
        raise HTTPException(status_code=404, detail="Mapping not found")
    
    del avanza_service.mapping[key]
    avanza_service._save_mappings()
    return {'message': 'Mapping deleted'}


@router.get("/historical/{ticker}")
def get_historical_dividends(ticker: str, years: int = 5):
    """Get historical dividends for a Swedish stock.
    
    Args:
        ticker: The Yahoo Finance ticker (must end with .ST).
        years: Number of years of history (default 5).
    
    Returns:
        list: Historical dividends from aktieutdelningar.now.sh.
    """
    if not ticker.upper().endswith('.ST'):
        raise HTTPException(status_code=400, detail="Only Swedish stocks (.ST) are supported")
    
    dividends = avanza_service.get_historical_dividends(ticker, years)
    return dividends


@router.get("/stock/{instrument_id}")
def get_stock_info(instrument_id: str):
    """Get stock info including dividends from aktieutdelningar.now.sh.
    
    Args:
        instrument_id: The Avanza instrument ID.
    
    Returns:
        dict: Stock information including upcoming and past dividends.
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
