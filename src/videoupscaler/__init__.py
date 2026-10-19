"""Python client and CLI for the VideoUpscaler API (https://videoupscaler.co/docs)."""

from videoupscaler.client import (
    DEFAULT_BASE_URL,
    ApiError,
    Client,
    UsageError,
    content_type_for,
)

__version__ = "0.1.0"

__all__ = [
    "ApiError",
    "Client",
    "DEFAULT_BASE_URL",
    "UsageError",
    "__version__",
    "content_type_for",
]
