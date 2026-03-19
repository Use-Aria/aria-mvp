"""Fetch raw iCal bytes from a Canvas iCal URL."""
import requests


def fetch_ical(ical_url: str, timeout: int = 30) -> bytes:
    """Fetch raw iCal bytes from Canvas iCal URL.

    Args:
        ical_url: Canvas calendar feed URL with embedded secret token.
        timeout: Request timeout in seconds.
    Returns:
        Raw iCal bytes.
    Raises:
        requests.HTTPError: On 4xx/5xx responses (including 429 rate limit).
    """
    response = requests.get(ical_url, timeout=timeout)
    response.raise_for_status()
    return response.content
