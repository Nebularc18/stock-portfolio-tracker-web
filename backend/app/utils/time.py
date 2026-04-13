from datetime import datetime, timezone


def utc_now() -> datetime:
    """
    Return the current date and time in UTC.
    
    Returns:
        datetime: Timezone-aware datetime representing the current moment in UTC.
    """
    return datetime.now(timezone.utc)


def floor_datetime_to_interval(value: datetime, interval_minutes: int) -> datetime:
    """
    Floor a datetime to the start of its containing minute interval.

    For example, a 10-minute interval turns 08:59:30 into 08:50:00 while
    preserving the original timezone information.
    """
    if interval_minutes <= 0 or interval_minutes > 60:
        raise ValueError("interval_minutes must be between 1 and 60")

    floored_minute = (value.minute // interval_minutes) * interval_minutes
    return value.replace(minute=floored_minute, second=0, microsecond=0)
