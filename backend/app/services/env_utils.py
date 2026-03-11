"""Helpers for parsing environment variables safely."""

import os
import logging


def parse_float_env(name: str, default: float, logger: logging.Logger | None = None) -> float:
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
