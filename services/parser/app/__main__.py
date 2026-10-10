"""`python -m app`: run the service with uvicorn (Cloud Run sets PORT)."""

from __future__ import annotations

import os

import uvicorn

from app.logging import logging_config


def main() -> None:
    """Start uvicorn on 0.0.0.0:$PORT with JSON logging and no access log."""
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",  # noqa: S104 - container entrypoint
        port=int(os.environ.get("PORT", "8080")),
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_config=logging_config(os.environ.get("LOG_LEVEL", "info")),
        access_log=False,
        server_header=False,
        timeout_graceful_shutdown=10,
    )


if __name__ == "__main__":
    main()
