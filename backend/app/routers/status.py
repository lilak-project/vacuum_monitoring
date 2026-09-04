"""WebSocket status stream.

Only the current reading of each device goes over this socket. History is a
query against a time window, so a browser watching a run that has been going
for a week costs the same as one watching a run that started a minute ago --
which is the thing the previous service got wrong.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import BROADCAST_INTERVAL
from ..monitor import monitor

log = logging.getLogger(__name__)
router = APIRouter()


class StatusBroadcaster:
    """Fans one snapshot per tick out to every subscribed browser."""

    def __init__(self, interval: float = BROADCAST_INTERVAL) -> None:
        self.interval = interval
        self._clients: set[WebSocket] = set()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="status-broadcast")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def subscribe(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.add(websocket)
        # Send at once, so a fresh tab is not blank for up to one interval.
        await websocket.send_json(self._payload())

    def unsubscribe(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)

    @staticmethod
    def _payload() -> dict:
        return {
            "type": "status",
            "mode": monitor.mode,
            "devices": monitor.snapshots(),
        }

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            if not self._clients:
                continue
            payload = self._payload()
            for websocket in list(self._clients):
                try:
                    await websocket.send_json(payload)
                except Exception:
                    self.unsubscribe(websocket)


broadcaster = StatusBroadcaster()


@router.websocket("/ws/status")
async def status_stream(websocket: WebSocket) -> None:
    await broadcaster.subscribe(websocket)
    try:
        # The client never sends anything; this just parks until it goes away.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("status websocket closed unexpectedly", exc_info=True)
    finally:
        broadcaster.unsubscribe(websocket)
