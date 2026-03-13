"""Helpers for parsing environment variables safely."""

import os
import logging


def parse_float_env(name: str, default: float, logger: logging.Logger | None = None) -> float:
    """
    Parse an environment variable as a float, returning a default when the variable is missing, blank, or cannot be converted.
    
    Parameters:
        name (str): Environment variable name to read.
        default (float): Value to return if the environment variable is absent, empty (after trimming), or invalid.
        logger (logging.Logger | None): Optional logger; if provided, a warning is emitted when the variable exists but cannot be parsed as a float.
    
    Returns:
        float: The parsed float value from the environment variable, or `default` if parsing is not possible.
    """
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    trimmed_value = raw_value.strip()
    if trimmed_value == '':
        return default

    try:
        return float(trimmed_value)
    except ValueError:
        if logger is not None:
            logger.warning("Invalid float for %s=%r; using default %s", name, raw_value, default)
        return default
