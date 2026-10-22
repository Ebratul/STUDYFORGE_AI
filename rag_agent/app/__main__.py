"""`python -m app` runs the service with HOST/PORT from the environment (the documented alternative is the uvicorn CLI)."""

from __future__ import annotations

import uvicorn

from app.config import load_settings_or_exit
from app.main import create_app


def main() -> None:
    settings = load_settings_or_exit()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
