"""Twilio SMS sending with TCPA guard enforcement.

NOTE: This is a stub created for Plan 02 (commands.py) to import against.
Full implementation is in Plan 01.
"""


def send_sms_safe(
    user_id: str,
    to_phone: str,
    body: str,
    is_proactive: bool = True,
) -> bool:
    """Send SMS through TCPA guards. Returns True if sent, False if suppressed."""
    raise NotImplementedError("Stub — implemented in Plan 01")


def send_sms_direct(to_phone: str, body: str) -> str:
    """Send SMS directly via Twilio without guards. Returns message SID.

    Used ONLY for STOP confirmation (user just opted out, guard would block).
    """
    raise NotImplementedError("Stub — implemented in Plan 01")
