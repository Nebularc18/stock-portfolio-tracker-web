# Dividend Fixes Plan

## Summary of Investigation

After analyzing the codebase, I've identified the following issues and their root causes:

### Completed Tasks

1. **Ex-date & dividends on main page** - Already working correctly in [`Dashboard.tsx`](frontend/src/pages/Dashboard.tsx:280-335)
2. **Dividends tab renamed** - Changed to "Dividends History" in [`InfographicLayout.tsx`](frontend/src/layouts/InfographicLayout.tsx:50)
3. **Symbols in portfolio** - Already displayed correctly in [`Stocks.tsx`](frontend/src/pages/Stocks.tsx:276)

### Remaining Issues to Fix

## Issue 1: American Stocks Not Showing Dividends from yfinance

### Problem Analysis

The user reports that American stocks don't show dividends. Looking at [`stock_service.py:453-522`](backend/app/services/stock_service.py:453-522):

```python
def get_upcoming_dividends(self, ticker: str) -> Optional[List[Dict[str, Any]]]:
    # First checks Avanza mapping (for Swedish .ST stocks)
    avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
    if avanza_mapping and avanza_mapping.instrument_id:
        # Uses Avanza for Swedish stocks
        ...
    
    # Falls back to yfinance for other stocks
    try:
        yf = importlib.import_module('yfinance')
        yf_ticker = yf.Ticker(ticker)
        calendar = getattr(yf_ticker, 'calendar', None)
        ...
```

### Root Cause

The yfinance fallback may have issues:
1. The `calendar` attribute format might have changed in newer yfinance versions
2. The `Dividend Date` key might not exist or have a different format
3. Error handling might be silently failing

### Proposed Fix

1. Add better logging to `get_upcoming_dividends()` to capture yfinance errors
2. Update the yfinance calendar parsing to handle different response formats
3. Add a fallback to fetch dividend info from `yf_ticker.info` if calendar fails

## Issue 2: Broken Dividends on Avanza Stocks in Stock Detail View

### Problem Analysis

When clicking on a Swedish stock and viewing its detail page, dividends may not show. The flow is:

1. Frontend calls [`api.stocks.dividends(ticker)`](frontend/src/services/api.ts:283) and [`api.stocks.upcomingDividends(ticker)`](frontend/src/services/api.ts:284)
2. Backend routes to [`/stocks/{ticker}/dividends`](backend/app/routers/stocks.py:243) and [`/stocks/{ticker}/upcoming-dividends`](backend/app/routers/stocks.py:269)
3. These call [`stock_service.get_dividends()`](backend/app/services/stock_service.py:377) and [`stock_service.get_upcoming_dividends()`](backend/app/services/stock_service.py:453)

### Root Cause

For Swedish stocks, the code checks for Avanza mapping:
```python
avanza_mapping = avanza_service.get_mapping_by_ticker(ticker)
if avanza_mapping and avanza_mapping.instrument_id:
    avanza_divs = avanza_service.get_historical_dividends(ticker, years)
```

The issue could be:
1. **Missing mapping**: The stock might not have a mapping in `ticker_mapping.json`
2. **Missing instrument_id**: The mapping exists but `instrument_id` is `None`
3. **API failure**: The Avanza API call might be failing silently

### Proposed Fix

1. Add logging to track mapping lookup results
2. Ensure graceful fallback to yfinance when Avanza mapping is incomplete
3. Check if the `ticker_mapping.json` file has all necessary mappings

## Implementation Steps

### Step 1: Improve yfinance Dividend Fetching

**File**: `backend/app/services/stock_service.py`

1. Add debug logging to `get_upcoming_dividends()`
2. Handle multiple yfinance calendar formats
3. Add fallback to `yf_ticker.info.get('dividendRate')` and `yf_ticker.info.get('exDividendDate')`

### Step 2: Improve Avanza Mapping Fallback

**File**: `backend/app/services/stock_service.py`

1. When Avanza mapping exists but `instrument_id` is missing, log a warning
2. Ensure fallback to yfinance for Swedish stocks without complete Avanza mapping

### Step 3: Add Error Handling in Stock Detail

**File**: `frontend/src/pages/StockDetail.tsx`

1. Add error handling for failed dividend API calls
2. Display user-friendly error messages when dividend data is unavailable

## Code Changes Required

### backend/app/services/stock_service.py

```python
# In get_upcoming_dividends():
# Add better yfinance handling

try:
    yf = importlib.import_module('yfinance')
    yf_ticker = yf.Ticker(ticker)
    
    # Try calendar first
    calendar = getattr(yf_ticker, 'calendar', None)
    
    if calendar and isinstance(calendar, dict):
        dividend_date = calendar.get('Dividend Date')
        # ... existing logic
    
    # Fallback: Try to get from info
    info = getattr(yf_ticker, 'info', {}) or {}
    ex_dividend_date = info.get('exDividendDate')
    dividend_rate = info.get('dividendRate')
    
    if ex_dividend_date and dividend_rate:
        # Convert timestamp to date string
        if isinstance(ex_dividend_date, (int, float)):
            from datetime import datetime
            ex_date = datetime.fromtimestamp(ex_dividend_date).strftime('%Y-%m-%d')
        else:
            ex_date = str(ex_dividend_date)[:10]
        
        return [{
            'ex_date': ex_date,
            'amount': dividend_rate,
            'currency': info.get('currency'),
            'source': 'yahoo'
        }]
    
except Exception as e:
    logger.error(f"Error fetching upcoming dividends for {ticker}: {e}")
```

### backend/app/services/avanza_service.py

Add logging to track mapping issues:

```python
def get_stock_dividend(self, yahoo_ticker: str) -> Optional[AvanzaDividend]:
    if not yahoo_ticker.upper().endswith('.ST'):
        return None
    
    mapping = self.get_mapping_by_ticker(yahoo_ticker)
    if not mapping:
        logger.debug(f"No Avanza mapping found for {yahoo_ticker}")
        return None
    
    if not mapping.instrument_id:
        logger.warning(f"Avanza mapping for {yahoo_ticker} has no instrument_id")
        return None
    
    # ... rest of the method
```

## Testing Plan

1. Test American stocks (e.g., AAPL, MSFT) to verify yfinance dividend fetching
2. Test Swedish stocks with Avanza mapping to verify Avanza dividend fetching
3. Test Swedish stocks without mapping to verify yfinance fallback
4. Check stock detail page for both American and Swedish stocks

## Files to Modify

1. `backend/app/services/stock_service.py` - Improve yfinance dividend fetching
2. `backend/app/services/avanza_service.py` - Add logging for mapping issues
3. `frontend/src/pages/StockDetail.tsx` - Add error handling (optional)