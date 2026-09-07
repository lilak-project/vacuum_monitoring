"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state"}], "note": ""}

Assembled from state the service already holds; never touches hardware or a
remote host on the request path, so it is safe to poll every few seconds.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..monitor import monitor

router = APIRouter(tags=["live"])


def _fmt(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    if v != 0 and (abs(v) < 1e-2 or abs(v) >= 1e5):
        return f"{v:.2e}"
    return f"{v:.3g}"


@router.get("/api/live")
def live() -> dict:
    items = []
    for d in monitor.snapshots():
        # Device status vocabulary: open/attached = talking, error/closed = not.
        reading = d.get("status") in ("open", "attached", "reading")
        for ch in d.get("channels") or []:
            if ch.get("value") is None:
                continue
            items.append({
                "label": f"{d.get('name') or d.get('id')} · {ch.get('label') or ch.get('key')}" if len(d.get("channels") or []) > 1 else (d.get("name") or d.get("id")),
                "value": _fmt(ch["value"]),
                "unit": ch.get("unit") or "",
                "state": "ok" if reading else "warn",
            })
            if d.get("measure") == "pressure":
                break                                   # one pressure per gauge is the point
        if not (d.get("channels") or []) or all(ch.get("value") is None for ch in d.get("channels") or []):
            items.append({"label": d.get("name") or d.get("id"), "value": "—", "unit": "", "state": "down" if d.get("last_error") else "off",
                          "sub": (d.get("last_error") or d.get("status") or "")[:40]})
    if not items:
        items.append({"label": "vacuum", "value": "—", "unit": "", "state": "off", "sub": "no device"})
    return {"ok": True, "items": items}
