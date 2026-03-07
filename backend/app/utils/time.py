from datetime import datetime, timezone


def utc_now() -> datetime:
    """
    Return the current date and time in UTC.
    
    Returns:
        datetime: Timezone-aware datetime representing the current moment in UTC.
    """
    return datetime.now(timezone.utc)
