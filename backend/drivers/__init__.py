"""Serial drivers for the gauges and thermometers on the beamline.

These files came across from the previous CMMS web service unchanged apart
from their imports: they talk to real hardware, and a rewrite would have been
a rewrite of the one part that is known to work. Everything that describes
*what* they read for the operator lives in :mod:`app.catalog` instead, so the
drivers stay the thin protocol layer they were.
"""

from .bcg450 import BCG450
from .ls218 import LS218
from .m1 import M1, M2
from .sermeasure import SerMeasure, UnitType
from .serman import SerMan
from .tic100 import TIC100
from .tpg36x import TPG36X
from .vgc401 import VGC401

#: Every device type the service can open, by the name used in the API.
DEVICE_CLASSES: dict[str, type] = {
    "BCG450": BCG450,
    "TPG36X": TPG36X,
    "VGC401": VGC401,
    "LS218": LS218,
    "TIC100": TIC100,
    "M1": M1,
    "M2": M2,
}

__all__ = [
    "BCG450",
    "LS218",
    "M1",
    "M2",
    "SerMan",
    "SerMeasure",
    "TIC100",
    "TPG36X",
    "UnitType",
    "VGC401",
    "DEVICE_CLASSES",
]
