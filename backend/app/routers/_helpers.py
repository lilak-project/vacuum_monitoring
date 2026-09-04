"""Shared bits of the route layer."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

from ..monitor import Device, monitor


async def run_io(func, *args, **kwargs) -> Any:
    """Run a blocking call off the event loop.

    Opening a gauge waits on a serial timeout and reading a CSV window walks a
    file; neither belongs on the loop that is also serving the status socket.
    """
    return await run_in_threadpool(func, *args, **kwargs)


def find_device(device_id: str) -> Device:
    try:
        return monitor.get(device_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No device {device_id!r} is open") from None
