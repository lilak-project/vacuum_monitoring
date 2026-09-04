"""Vacuum monitoring service.

Serves a JSON API plus a WebSocket status stream, and (once the frontend is
built) the single-page UI from the same origin and port.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from .config import STATIC_DIR
from .drivers_bridge import AVAILABLE, IMPORT_ERROR
from .monitor import monitor
from . import elog
from .routers import devices, logs, profiles, sources, status
from .store import load_profiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vacuum")


class _QuietPolling(logging.Filter):
    """Keep the chart's window queries out of the access log.

    A browser following a live run re-reads its window every few seconds. At
    INFO that is a wall of identical lines and nothing else is readable.
    """

    QUIET_PATHS = ("/api/devices", "/api/logs")

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = str(args[2])
            return not (path.startswith(self.QUIET_PATHS) and "series" in path)
        return True


logging.getLogger("uvicorn.access").addFilter(_QuietPolling())


def _connect_autostart_profiles() -> None:
    """Reconnect the profiles marked autostart, so a restart is not a re-setup."""
    for profile in load_profiles():
        if not profile.get("autostart"):
            continue
        try:
            # Continuing, not starting fresh: a service restart is not a new
            # experiment, and the chart should not lose what it had.
            monitor.connect_profile(profile, continue_history=True)
        except Exception as err:
            # A gauge that is switched off, or a host that is down, must not
            # stop the service coming up.
            log.warning("could not connect %s: %s", profile["name"], err)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if not AVAILABLE:
        log.warning("serial mode is unavailable: %s", IMPORT_ERROR)
    else:
        _connect_autostart_profiles()
    monitor.start()
    await status.broadcaster.start()
    try:
        yield
    finally:
        await status.broadcaster.stop()
        # Release the serial ports, and close every CSV cleanly.
        monitor.stop()


app = FastAPI(
    title="Vacuum Monitoring",
    description=(
        "Pressure and temperature monitoring for the beamline gauges. "
        "Every reading carries where it came from: which instrument, which "
        "channel, what the driver asked for, and which file it was written to."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# The Vite dev server runs on another port; in production the UI is same-origin
# and these headers are simply unused.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"http://(localhost|127\.0\.0\.1"
        r"|10\.\d+\.\d+\.\d+"
        r"|192\.168\.\d+\.\d+"
        r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sources.router)
app.include_router(profiles.router)
app.include_router(devices.router)
app.include_router(logs.router)
app.include_router(status.router)
# The LILAK elog asks this service to fill a task log; see app/elog.py.
app.include_router(elog.router)


@app.get("/api/health", tags=["meta"])
async def health() -> dict:
    config = monitor.config()
    return {
        "ok": True,
        "mode": config["mode"],
        "devices": [device.id for device in monitor.devices()],
        "serial_available": AVAILABLE,
    }


class UiFiles(StaticFiles):
    """Serve the built UI, revalidating the entry point on every load.

    Vite fingerprints the asset filenames, so those can be cached hard. The
    HTML that points at them must not be, or a browser keeps running the
    previous build after a redeploy and calls endpoints that no longer exist.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith(".html") or path in ("", "."):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif response.status_code == 200 and "/assets/" in scope.get("path", ""):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if STATIC_DIR.is_dir():
    # Mounted last so it never shadows /api or /ws.
    app.mount("/", UiFiles(directory=STATIC_DIR, html=True), name="ui")
else:
    log.warning("Frontend build not found at %s - run `npm run build` in frontend/", STATIC_DIR)

    @app.get("/", tags=["meta"])
    async def missing_ui() -> dict:
        return {
            "ok": False,
            "error": "Frontend is not built.",
            "hint": "cd frontend && npm install && npm run build",
            "api_docs": "/docs",
        }
