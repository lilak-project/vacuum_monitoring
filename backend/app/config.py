"""Filesystem locations and tunables shared by the whole backend."""

from __future__ import annotations

import os
from pathlib import Path

#: backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent

#: Where this service's STATE lives -- kept apart from its code so the service is
#: movable as one folder (LILAK SERVICE_CONTRACT §9). Standalone this is
#: ``backend/``, exactly as before. Started by the LILAK portal it is the portal's
#: own data dir for this service, handed over as PORTAL_DATA_ROOT + PORTAL_SERVICE.
#: Deriving it here rather than spelling it out in the service manifest is what
#: keeps absolute paths out of that manifest: the portal substitutes {data_root}
#: style placeholders for multi-project services only, never for a single one.
_portal_root = os.environ.get("PORTAL_DATA_ROOT")
_portal_service = os.environ.get("PORTAL_SERVICE")
STATE_ROOT = (Path(_portal_root) / _portal_service
              if _portal_root and _portal_service else BACKEND_ROOT)

#: Where devices.json lives.  Override with VACUUM_DATA_DIR.
DATA_DIR = Path(os.environ.get("VACUUM_DATA_DIR", STATE_ROOT / "data")).resolve()

#: Saved profiles -- the instruments and remote services this service knows
#: about -- so a restart does not mean adding every gauge back by hand.
PROFILE_FILE = DATA_DIR / "profiles.json"

#: Root of the measurement logs.  CSV files go in ``<LOG_ROOT>/CSV``.
LOG_ROOT = Path(os.environ.get("VACUUM_LOG_DIR", STATE_ROOT / "log")).resolve()

#: Built frontend (``frontend/dist``).  Served at / when present.
STATIC_DIR = Path(
    os.environ.get("VACUUM_STATIC_DIR", BACKEND_ROOT.parent / "frontend" / "dist")
).resolve()

#: How often every open device is read.  One reading a second is what the
#: gauges themselves update at, and what every CSV in log/ was written at.
POLL_INTERVAL = float(os.environ.get("VACUUM_POLL_INTERVAL", "1.0"))

#: How often the latest values are pushed to the browsers.  Only the current
#: reading goes over this socket -- history is fetched per chart window, so the
#: rate here costs a few hundred bytes a tick however long the run has been.
BROADCAST_INTERVAL = float(os.environ.get("VACUUM_BROADCAST_INTERVAL", "0.5"))

#: Samples kept in memory per channel: 24 h at one a second.  Anything older is
#: still on disk, and the chart reads it back from the CSV.
HISTORY_LIMIT = int(os.environ.get("VACUUM_HISTORY_LIMIT", str(24 * 60 * 60)))

#: Points a series endpoint will return before it decimates.  Two thousand is
#: about four per horizontal pixel on a wide chart -- past that the wire cost
#: is real and nothing new becomes visible.
DEFAULT_MAX_POINTS = 2000
MAX_MAX_POINTS = 20000

#: Rows a windowed read of a CSV will parse before it starts skipping. A month
#: of one channel is 2.6 million rows; reading all of them to draw 2 000 points
#: is work nobody sees.
FILE_ROW_BUDGET = 400_000

#: Offered as the placeholder when adding a remote profile.
DEFAULT_REMOTE_URL = os.environ.get("VACUUM_REMOTE_URL", "http://192.168.1.102:8002")
