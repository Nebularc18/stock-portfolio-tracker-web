from datetime import datetime, time
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


def convert_time_to_timezone(time_str: str, from_tz: str, to_tz: str, base_date: datetime = None) -> str:
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
    @staticmethod
    def is_market_open(market: str) -> bool:
        if market not in MARKET_CONFIG:
            return False
        
        config = MARKET_CONFIG[market]
        
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(config["timezone"])
            now = datetime.now(tz)
            
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
    def get_market_status(market: str, user_timezone: str = None) -> Dict:
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
    def get_all_markets_status(user_timezone: str = None) -> List[Dict]:
        results = []
        for market in MARKET_CONFIG:
            results.append(MarketHoursService.get_market_status(market, user_timezone))
        return results

    @staticmethod
    def get_open_markets() -> List[str]:
        open_markets = []
        for market in MARKET_CONFIG:
            if MarketHoursService.is_market_open(market):
                open_markets.append(market)
        return open_markets

    @staticmethod
    def is_within_post_close_window(market: str, minutes_after_close: int = 30) -> bool:
        if market not in MARKET_CONFIG:
            return False
        
        config = MARKET_CONFIG[market]
        
        try:
            from zoneinfo import ZoneInfo
            from datetime import timedelta
            
            tz = ZoneInfo(config["timezone"])
            now = datetime.now(tz)
            
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
    def should_refresh() -> bool:
        for market in ["SE", "US"]:
            if MarketHoursService.is_market_open(market):
                return True
            if MarketHoursService.is_within_post_close_window(market):
                return True
        return False
