"""Market hours tracking service.

This module provides functionality to track market open/close times,
determine if markets are currently open, and check if data refresh
should occur based on market hours.
"""

from datetime import date, datetime, time, timedelta
from typing import Dict, List
import logging

logger = logging.getLogger(__name__)

MARKET_CONFIG = {
    "SE": {
        "name": "Stockholm (OMX)",
        "exchanges": ["OMX"],
        "timezone": "Europe/Stockholm",
        "display_tz": "CET",
        "open_time": "09:00",
        "close_time": "17:25",
        "days": [0, 1, 2, 3, 4],
    },
    "US": {
        "name": "US Markets (NYSE/NASDAQ)",
        "exchanges": ["NYSE", "NASDAQ"],
        "timezone": "America/New_York",
        "display_tz": "ET",
        "open_time": "09:30",
        "close_time": "16:00",
        "days": [0, 1, 2, 3, 4],
    },
    "UK": {
        "name": "London (LSE)",
        "exchanges": ["LSE"],
        "timezone": "Europe/London",
        "display_tz": "GMT",
        "open_time": "08:00",
        "close_time": "16:30",
        "days": [0, 1, 2, 3, 4],
    },
    "DE": {
        "name": "Frankfurt (XETRA)",
        "exchanges": ["XETRA"],
        "timezone": "Europe/Berlin",
        "display_tz": "CET",
        "open_time": "09:00",
        "close_time": "17:30",
        "days": [0, 1, 2, 3, 4],
    },
}

MARKET_BY_TICKER_SUFFIX = {
    ".ST": "SE",
    ".L": "UK",
    ".DE": "DE",
}
DEFAULT_REFRESH_INTERVAL_MINUTES = 10


def convert_time_to_timezone(time_str: str, from_tz: str, to_tz: str, base_date: date | None = None) -> str:
    """Convert a time string from one timezone to another.
    
    Args:
        time_str: Time in 'HH:MM' format.
        from_tz: Source timezone name.
        to_tz: Target timezone name.
        base_date: Optional base date for conversion.
    
    Returns:
        str: Converted time in 'HH:MM' format.
    """
    try:
        from zoneinfo import ZoneInfo
        
        if base_date is None:
            base_date = datetime.now(ZoneInfo(from_tz)).date()
        
        hour, minute = map(int, time_str.split(':'))
        
        dt = datetime.combine(base_date, time(hour, minute), tzinfo=ZoneInfo(from_tz))
        converted = dt.astimezone(ZoneInfo(to_tz))
        
        return converted.strftime("%H:%M")
    except Exception as e:
        logger.error(f"Error converting time: {e}")
        return time_str


class MarketHoursService:
    """Service for tracking market hours and status.
    
    Provides methods to check if markets are open, get market status,
    and determine if data refresh should occur based on market hours.
    """
    
    @staticmethod
    def infer_market_for_ticker(
        ticker: str | None,
        *,
        assume_unsuffixed_us: bool = False,
    ) -> str | None:
        """Infer the configured market for a ticker from its Yahoo-style suffix."""
        normalized_ticker = (ticker or "").strip().upper()
        if not normalized_ticker:
            return None
        for suffix, market in MARKET_BY_TICKER_SUFFIX.items():
            if normalized_ticker.endswith(suffix):
                return market
        if assume_unsuffixed_us and "." not in normalized_ticker:
            return "US"
        return None

    @staticmethod
    def is_market_open(market: str, now: datetime | None = None) -> bool:
        """Check if a market is currently open.
        
        Args:
            market: Market identifier (e.g., 'SE', 'US', 'UK', 'DE').
        
        Returns:
            bool: True if market is open, False otherwise.
        """
        if market not in MARKET_CONFIG:
            return False
        
        config = MARKET_CONFIG[market]
        
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(config["timezone"])
            now = now.astimezone(tz) if now is not None else datetime.now(tz)
            
            if now.weekday() not in config["days"]:
                return False
            
            open_parts = config["open_time"].split(":")
            close_parts = config["close_time"].split(":")
            
            open_time = time(int(open_parts[0]), int(open_parts[1]))
            close_time = time(int(close_parts[0]), int(close_parts[1]))
            
            current_time = now.time()
            
            return open_time <= current_time <= close_time
        except Exception as e:
            logger.error(f"Error checking market hours for {market}: {e}")
            return False

    @staticmethod
    def get_market_status(market: str, user_timezone: str | None = None) -> Dict:
        """Get detailed status for a specific market.
        
        Args:
            market: Market identifier (e.g., 'SE', 'US').
            user_timezone: Optional timezone for time display.
        
        Returns:
            dict: Market status with is_open, open_time, close_time,
                timezone, and local_time fields.
        """
        if market not in MARKET_CONFIG:
            return {"error": "Unknown market"}
        
        config = MARKET_CONFIG[market]
        is_open = MarketHoursService.is_market_open(market)
        
        try:
            from zoneinfo import ZoneInfo
            
            market_tz = ZoneInfo(config["timezone"])
            now_market = datetime.now(market_tz)
            local_time = now_market.strftime("%H:%M")
            
            if user_timezone and user_timezone != config["timezone"]:
                open_time_user = convert_time_to_timezone(
                    config["open_time"], 
                    config["timezone"], 
                    user_timezone
                )
                close_time_user = convert_time_to_timezone(
                    config["close_time"], 
                    config["timezone"], 
                    user_timezone
                )
                now_user = datetime.now(ZoneInfo(user_timezone))
                user_time = now_user.strftime("%H:%M")
                tz_display = user_timezone.split('/')[-1].replace('_', ' ')
            else:
                open_time_user = config["open_time"]
                close_time_user = config["close_time"]
                user_time = local_time
                tz_display = config["display_tz"]
                
        except Exception as e:
            logger.error(f"Error getting market status: {e}")
            open_time_user = config["open_time"]
            close_time_user = config["close_time"]
            local_time = "-"
            user_time = "-"
            tz_display = config["display_tz"]
        
        return {
            "market": market,
            "name": config["name"],
            "is_open": is_open,
            "status": "Open" if is_open else "Closed",
            "open_time": open_time_user,
            "close_time": close_time_user,
            "timezone": tz_display,
            "local_time": user_time,
        }

    @staticmethod
    def get_all_markets_status(user_timezone: str | None = None) -> List[Dict]:
        """Get status for all tracked markets.
        
        Args:
            user_timezone: Optional timezone for time display.
        
        Returns:
            list: List of market status dictionaries.
        """
        results = []
        for market in MARKET_CONFIG:
            results.append(MarketHoursService.get_market_status(market, user_timezone))
        return results

    @staticmethod
    def get_open_markets() -> List[str]:
        """Get list of currently open markets.
        
        Returns:
            list: List of market identifiers that are currently open.
        """
        open_markets = []
        for market in MARKET_CONFIG:
            if MarketHoursService.is_market_open(market):
                open_markets.append(market)
        return open_markets

    @staticmethod
    def is_within_post_close_window(
        market: str,
        minutes_after_close: int = 30,
        now: datetime | None = None,
    ) -> bool:
        """Check if current time is within post-close window.
        
        Args:
            market: Market identifier.
            minutes_after_close: Minutes after close to consider (default 30).
        
        Returns:
            bool: True if within post-close window, False otherwise.
        """
        if market not in MARKET_CONFIG:
            return False
        
        config = MARKET_CONFIG[market]
        
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(config["timezone"])
            now = now.astimezone(tz) if now is not None else datetime.now(tz)
            
            if now.weekday() not in config["days"]:
                return False
            
            close_parts = config["close_time"].split(":")
            close_time = time(int(close_parts[0]), int(close_parts[1]))
            
            close_dt = datetime.combine(now.date(), close_time, tzinfo=tz)
            window_end = close_dt + timedelta(minutes=minutes_after_close)
            
            return close_dt <= now <= window_end
        except Exception as e:
            logger.error(f"Error checking post-close window for {market}: {e}")
            return False

    @staticmethod
    def should_refresh(
        markets: list[str] | None = None,
        minutes_after_close: int = DEFAULT_REFRESH_INTERVAL_MINUTES,
        now: datetime | None = None,
    ) -> bool:
        """Check if market data should be refreshed.
        
        Returns True if any supplied market is open or within the configured
        post-close refresh window. When no markets are supplied, defaults to
        the legacy SE/US behavior used by shared market widgets.
        
        Returns:
            bool: True if refresh should occur, False otherwise.
        """
        target_markets = list(dict.fromkeys(markets or ["SE", "US"]))
        for market in target_markets:
            if MarketHoursService.is_market_open(market, now=now):
                return True
            if MarketHoursService.is_within_post_close_window(
                market,
                minutes_after_close=minutes_after_close,
                now=now,
            ):
                return True
        return False
