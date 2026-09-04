"""The only place the app imports `drivers/` from.

pyserial and the instrument classes are kept behind this module so the rest of
the service -- and the tests, and anything running on a machine with no serial
hardware at all -- can be imported without them.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

try:
    from drivers import DEVICE_CLASSES, SerMan, UnitType

    AVAILABLE = True
    IMPORT_ERROR = ""
except Exception as err:  # pragma: no cover - only on a box without pyserial
    DEVICE_CLASSES = {}
    SerMan = None
    UnitType = None
    AVAILABLE = False
    IMPORT_ERROR = f"{type(err).__name__}: {err}"
    log.warning("serial drivers unavailable: %s", IMPORT_ERROR)


def measure_of_driver(driver: object, device_type: str) -> str:
    """"pressure" or "temperature", from the driver's own declaration."""
    from .catalog import measure_of

    kind = getattr(driver, "type", None)
    name = getattr(kind, "name", None)
    if name == "Temp":
        return "temperature"
    if name == "Pres":
        return "pressure"
    return measure_of(device_type)


def list_serial_ports() -> list[dict]:
    """Every serial port on the machine, with what is likely plugged into it."""
    from .catalog import suggest_types
    from .portlock import holders

    if not AVAILABLE or SerMan is None:
        return []
    ports = []
    for port in SerMan().get_ports():
        ports.append(
            {
                "device": port.device,
                "name": port.name,
                "description": port.description,
                "hwid": port.hwid,
                "vid": port.vid,
                "pid": port.pid,
                "serial_number": port.serial_number,
                "suggested_types": suggest_types(port.vid, port.pid),
                # This box reports 32 built-in /dev/ttyS* lines with nothing on
                # them. They are real ports, so they are listed, but the UI
                # folds them away behind "show all" -- an instrument is on a
                # USB adapter and has a hardware id.
                "physical": bool(port.hwid) and port.hwid != "n/a",
                # Shown beside the port, so an occupied one is visible before
                # anybody tries to open it rather than only after.
                "held_by": holders(port.device),
            }
        )
    return ports
