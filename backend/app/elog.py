"""The LILAK elog endpoint: one POST that answers both of elog's questions.

elog talks to a service through a single URL. Two different bodies arrive on it:

    {"event": "elog_handshake", "elog_url": …}
        -> who we are and what fields we can fill (Discover, once, at registration)

    {"format_id", "format_name", "task_log_id", "run_number", "requested_at", "mode"}
        -> the values themselves (every fill, on a task or on a schedule)

Two rules shape everything below.

**Five seconds.** elog gives up after that (`WEBHOOK_TIMEOUT_SEC`) and turns the
task into a manual one with the error as a comment. `mode` may also be
"realtime", which repeats as often as twice a second. So a reader here must be
cheap and must never block on hardware it does not already hold.

**The field list is fixed.** elog builds a log format from `log_fields` at
registration and matches it later by name *and* field signature: declare a
different set and a second format appears rather than the first one changing.
So `log_fields` must come from configuration, never from what is currently
plugged in, connected or selected -- otherwise unplugging a cable forks the
format and last week's entries stop lining up with this week's.

Copied into each service rather than shared from one place: these services are
each movable as a single folder (SERVICE_CONTRACT §9), and a shared import
would tie them together at runtime for eighty lines.
"""

from __future__ import annotations

import logging
import socket
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("elog")

HANDSHAKE = "elog_handshake"

#: A field elog can put on a log format.
#: `type` is one of number_entry | number | text | body | title | tags | level.
#: `metric` (number types only) makes it an Infography variable.
Field = dict[str, Any]


def number(key: str, label: str, unit: str = "", metric: bool = True) -> Field:
    """A numeric field. number_entry is the shape elog normalises to {value,error}."""
    return {"key": key, "label": label, "type": "number_entry", "unit": unit, "metric": metric}


def text(key: str, label: str) -> Field:
    return {"key": key, "label": label, "type": "text"}


def body(label: str = "Summary") -> Field:
    return {"key": "body", "label": label, "type": "body"}


def value(number_value: float | None, error: float = 0.0) -> dict:
    """One number_entry value. None stays None -- a channel that reported
    nothing is not the same as one that reported zero."""
    return {"value": None if number_value is None else float(number_value), "error": error}


def make_router(
    *,
    service_name: str,
    description: str,
    log_fields: list[Field] | Callable[[], Awaitable[list[Field]]],
    read: Callable[[dict], Awaitable[dict]],
    directory: str = "",
    path: str = "/api/elog",
) -> APIRouter:
    """The endpoint. `read(envelope)` returns the `fields` dict for one request.

    `log_fields` is normally a plain list -- a constant, which is what the
    "fixed field list" rule above asks for. It may instead be an async callable
    for a service whose fields come from its own saved configuration (which
    actuators are set up, say). That is still configuration and still stable;
    it just cannot be written down at import time. Such a callable should RAISE
    rather than return a short list when it cannot read that configuration, so
    Discover fails loudly instead of quietly registering half a format.

    Mount this BEFORE any catch-all `/api/{path}` route: FastAPI matches in
    registration order, and the read-only mirrors answer 405 to every POST they
    do not recognise -- including this one.
    """
    router = APIRouter(tags=["elog"])

    @router.post(path, summary="LILAK elog handshake and data request")
    async def elog_endpoint(request: Request):
        try:
            envelope = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"detail": "body must be JSON"})
        if not isinstance(envelope, dict):
            return JSONResponse(status_code=400, content={"detail": "body must be a JSON object"})

        event = envelope.get("event")
        if event == HANDSHAKE:
            log.info("elog handshake from %s", envelope.get("elog_url") or "?")
            try:
                fields = log_fields if isinstance(log_fields, list) else await log_fields()
            except Exception as err:
                log.warning("handshake refused: %s", err)
                return JSONResponse(status_code=503, content={"detail": str(err)})
            return {
                "name": service_name,
                "description": description,
                "hostname": socket.gethostname(),
                "directory": directory,
                # A service, not a system: elog asks us, we never push runs at it.
                "is_system": False,
                "log_fields": fields,
            }
        if event:
            # Only the handshake is an event. Anything else is a system-only
            # message (elog_credentials) or a typo, and answering it with
            # readings would be worse than saying so.
            return JSONResponse(
                status_code=400,
                content={"detail": f"unknown event {event!r}; this is a plain service, not a system"},
            )

        fields = await read(envelope)
        return {"fields": fields}

    return router


# ── This service's answer ────────────────────────────────────────────────────

from .config import LOG_ROOT                                       # noqa: E402
from .monitor import monitor                                       # noqa: E402
from .units import convert                                         # noqa: E402

#: What the elog log format holds. Fixed, however many gauges are open.
#:
#: The PRIMARY gauge's pressure is the graphable number and every open device is
#: listed in the body. One field per gauge would tie the log format to which
#: cable is plugged in today -- see the module docstring.
LOG_FIELDS = [
    number("pressure", "Vacuum level", "mbar"),
    text("gauge", "Gauge"),
    text("log_file", "Log file"),
    body("Every open device"),
]

#: The unit the `pressure` field is declared in, so the number always means the
#: same thing no matter which unit the gauge is being displayed in.
UNIT = "mbar"


def _pressure(device: dict) -> float | None:
    """The device's first real pressure reading, converted to mbar.

    A temperature probe (the LS218s share this service) has no vacuum level, so
    it is skipped rather than reported as one.
    """
    if device.get("measure") != "pressure":
        return None
    for channel in device.get("channels", []):
        if channel.get("value") is not None:
            return convert(channel["value"], channel.get("unit") or "", UNIT, "pressure")
    return None


def _primary(devices: list[dict]) -> dict | None:
    """The gauge this service is really about: the first open one reading pressure.

    Falls back to any pressure device, so a gauge that is open but has not
    answered yet reports itself with a null reading rather than vanishing.
    """
    pressure_devices = [d for d in devices if d.get("measure") == "pressure"]
    reading = [d for d in pressure_devices if _pressure(d) is not None and d.get("status") == "open"]
    return (reading or pressure_devices or [None])[0]


async def read(envelope: dict) -> dict:
    """The latest readings. Never touches a serial port: the monitor polls on
    its own and this hands back the value it already holds."""
    devices = monitor.snapshots()
    primary = _primary(devices)

    lines = []
    for device in devices:
        shown = "—"
        for channel in device.get("channels", []):
            if channel.get("value") is not None:
                shown = f"{channel['value']:.4g} {channel.get('unit') or ''}".strip()
                break
        lines.append(f"{device['name']:<18} {device.get('measure',''):<12} "
                     f"{device['status']:<8} {shown}")
    if not lines:
        lines.append("No device is open.")

    return {
        "pressure": value(_pressure(primary) if primary else None),
        "gauge": primary["name"] if primary else "",
        "log_file": (primary or {}).get("log_path") or "",
        "body": "\n".join(lines),
    }


router = make_router(
    service_name="Vacuum Monitoring",
    description="Vacuum gauge readout — the current level and the CSV it is being logged to.",
    log_fields=LOG_FIELDS,
    read=read,
    directory=str(LOG_ROOT),
)
