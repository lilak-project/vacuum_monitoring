"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub", "spark"}]}

One tile per gauge: its reading now, and `spark` -- the last hour of that
channel, decimated to a few dozen points, which the portal draws behind the
number. Pressure spans decades, so the tile also says `spark_log`: the wall
plots it on a log scale or the whole hour is a flat line at the bottom.

Everything comes from the ring buffer the poller already fills; the sparkline
is recomputed at most every SPARK_TTL seconds, so a wall polling every few
seconds costs nothing extra.
"""

from __future__ import annotations

import time

from fastapi import APIRouter

from ..monitor import monitor

router = APIRouter(tags=["live"])

#: How much of the past the sparkline shows, and how many points it is drawn with.
SPARK_WINDOW_SEC = 3600.0
SPARK_POINTS = 60
#: A sparkline is redrawn no more often than this, however fast the wall polls.
SPARK_TTL = 15.0

_spark_cache: dict[str, tuple[float, dict[int, list[float]]]] = {}


def _fmt(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    if v != 0 and (abs(v) < 1e-2 or abs(v) >= 1e5):
        return f"{v:.2e}"
    return f"{v:.3g}"


def _sparks(device) -> dict[int, list[float]]:
    """The last hour of every channel of one device, by channel index."""
    held = _spark_cache.get(device.id)
    now = time.monotonic()
    if held is not None and now - held[0] < SPARK_TTL:
        return held[1]
    out: dict[int, list[float]] = {}
    try:
        for channel, _times, values, _total, _decimated in device.series(
            time.time() - SPARK_WINDOW_SEC, None, SPARK_POINTS
        ):
            clean = [float(v) for v in values if v is not None]
            if len(clean) >= 2:
                out[channel.index] = clean
    except Exception:                      # a device whose history is unavailable
        out = {}
    _spark_cache[device.id] = (now, out)
    return out


@router.get("/api/live")
def live() -> dict:
    items = []
    for d in monitor.snapshots():
        # Device status vocabulary: open/attached = talking, error/closed = not.
        reading = d.get("status") in ("open", "attached", "reading")
        device = next((x for x in monitor.devices() if x.id == d.get("id")), None)
        sparks = _sparks(device) if device is not None else {}
        channels = d.get("channels") or []
        shown = False
        for ch in channels:
            if ch.get("value") is None:
                continue
            spark = sparks.get(ch.get("index"))
            items.append({
                "label": f"{d.get('name') or d.get('id')} · {ch.get('label') or ch.get('key')}"
                         if len(channels) > 1 else (d.get("name") or d.get("id")),
                "value": _fmt(ch["value"]),
                "unit": ch.get("unit") or "",
                "state": "ok" if reading else "warn",
                "spark": spark,
                "spark_log": bool(spark) and d.get("measure") == "pressure",
                "spark_window": "1 h",
            })
            shown = True
            if d.get("measure") == "pressure":
                break                       # one pressure per gauge is the point
        if not shown:
            items.append({"label": d.get("name") or d.get("id"), "value": "—", "unit": "",
                          "state": "down" if d.get("last_error") else "off",
                          "sub": (d.get("last_error") or d.get("status") or "")[:40]})
    if not items:
        items.append({"label": "vacuum", "value": "—", "unit": "", "state": "off", "sub": "no device"})
    return {"ok": True, "items": items}
