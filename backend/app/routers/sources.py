"""Where readings come from: the mode, the serial ports, the instrument types."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..catalog import CATALOG
from ..config import DEFAULT_REMOTE_URL
from ..drivers_bridge import AVAILABLE, IMPORT_ERROR, list_serial_ports
from ..monitor import monitor
from ..schemas import SourceRequest
from ..units import PRESSURE_UNITS, TEMPERATURE_UNITS
from ._helpers import run_io

router = APIRouter(prefix="/api", tags=["source"])


@router.get("/source")
async def read_source() -> dict:
    """The current mode and everything that configures it."""
    return {
        **monitor.config(),
        "modes": [
            {
                "id": "live",
                "label": "Live instruments",
                "detail": (
                    "Connect the gauges on this machine, and any other host running this "
                    "service. Readings are written to the log directory below."
                ),
                "available": AVAILABLE,
                "unavailable_reason": IMPORT_ERROR,
            },
            {
                "id": "attach",
                "label": "Attach to CSV",
                "detail": (
                    "Open logs already in that directory. Pick several and they are drawn "
                    "as one continuous trace. Nothing is measured and nothing is written."
                ),
                "available": True,
                "unavailable_reason": "",
            },
        ],
        "default_remote_url": DEFAULT_REMOTE_URL,
        "pressure_units": PRESSURE_UNITS,
        "temperature_units": TEMPERATURE_UNITS,
    }


@router.post("/source")
async def set_source(request: SourceRequest) -> dict:
    """Switch mode.  Everything open is closed first -- the two do not mix."""
    try:
        return await run_io(monitor.set_mode, request.mode)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.get("/ports")
async def serial_ports() -> list[dict]:
    """Every serial port, with the device type its USB id suggests."""
    return await run_io(list_serial_ports)


@router.get("/device-types")
async def device_types() -> list[dict]:
    """What each supported instrument is and how it is read.

    Static, so the reference screen works with nothing connected.
    """
    return [spec.as_dict() for spec in CATALOG.values()]
