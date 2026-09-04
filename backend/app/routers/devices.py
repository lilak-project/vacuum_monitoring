"""The open devices: what they read, where that came from, and their history."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..config import DEFAULT_MAX_POINTS, MAX_MAX_POINTS
from ..monitor import monitor
from ..provenance import describe
from ..schemas import AttachRequest, DeviceSnapshot, SeriesResponse
from ..units import canonical_unit, conversion
from ._helpers import find_device, run_io

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("", response_model=list[DeviceSnapshot])
async def list_devices() -> list[dict]:
    """Every open device, with its latest reading and no history."""
    return monitor.snapshots()


@router.post("/attach", response_model=DeviceSnapshot, status_code=201)
async def attach(request: AttachRequest) -> dict:
    """Open one or more saved logs as a single tab, joined end to end in time."""
    try:
        return await run_io(monitor.attach_files, request.filenames, request.name)
    except (ValueError, FileNotFoundError) as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.delete("/{device_id}", status_code=204)
async def remove_device(device_id: str) -> None:
    """Close a device or a file tab."""
    try:
        await run_io(monitor.remove_device, device_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No device {device_id!r} is open") from None


@router.get("/{device_id}/provenance")
async def device_provenance(
    device_id: str,
    units: str = Query("", description="Display units as index:unit pairs, e.g. 0:mbar,1:Pa"),
) -> dict:
    """Everything known about where this device's numbers come from."""
    device = find_device(device_id)
    return await run_io(describe, device, _parse_units(units, device.measure))


@router.get("/{device_id}/series", response_model=SeriesResponse)
async def device_series(
    device_id: str,
    start: float | None = Query(None, alias="from", description="Unix seconds, inclusive"),
    end: float | None = Query(None, alias="to", description="Unix seconds, inclusive"),
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=2, le=MAX_MAX_POINTS),
    units: str = Query("", description="Display units as index:unit pairs, e.g. 0:mbar"),
    channel: int | None = Query(None, ge=0, description="One channel only"),
) -> dict:
    """The samples in a time window, decimated to what a chart can show.

    The device decides where they come from -- a ring buffer for something
    being read now, the files themselves for a tab made of logs. Decimation
    keeps the minimum and maximum of every bucket either way, so a spike one
    sample wide is still on screen after the window is widened to a month.
    """
    device = find_device(device_id)
    display = _parse_units(units, device.measure)
    return await run_io(_build_series, device, start, end, max_points, display, channel)


def _build_series(device, start, end, max_points, display, only_channel) -> dict:
    series = []
    for channel, times, values, total, was_decimated in device.series(start, end, max_points):
        if only_channel is not None and channel.index != only_channel:
            continue
        target = display.get(channel.index, channel.unit)
        factor = conversion(channel.unit, target, device.measure)
        if not factor.is_identity:
            values = [value * factor.factor + factor.offset for value in values]
        series.append(
            {
                "index": channel.index,
                "label": channel.label,
                "unit": target,
                "device_unit": channel.unit,
                "conversion": {
                    "factor": factor.factor,
                    "offset": factor.offset,
                    "identity": factor.is_identity,
                    "description": factor.describe(channel.unit, target),
                },
                "t": times,
                "v": values,
                "total": total,
                "decimated": was_decimated,
            }
        )
    return {
        "id": device.id,
        "name": device.name,
        "measure": device.measure,
        "source": device.source,
        "start": start,
        "end": end,
        "max_points": max_points,
        "series": series,
    }


@router.get("/{device_id}/samples")
async def device_samples(
    device_id: str,
    channel: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
) -> dict:
    """The last few samples as numbers, not as a line.

    A chart is an argument about the data; this is the data. It is here so
    "what is actually being plotted" has an answer you can read.
    """
    device = find_device(device_id)
    found = next((c for c in device.channels if c.index == channel), None)
    if found is None:
        raise HTTPException(status_code=404, detail=f"{device.name} has no channel {channel}")

    if found.buffer is not None:
        times, values = found.buffer.window(None, None)
        rows = list(zip(times[-limit:], values[-limit:]))
    else:
        # A file tab: ask for the tail of its window rather than reading it all.
        end = found.last_at
        start = None if end is None else end - max(60.0, limit * 2.0)
        rows = []
        for item, times, values, _total, _dec in device.series(start, end, limit * 4):
            if item.index == channel:
                rows = list(zip(times[-limit:], values[-limit:]))
                break

    return {
        "id": device.id,
        "channel": channel,
        "label": found.label,
        "unit": found.unit,
        "samples": [{"at": at, "value": value} for at, value in rows],
    }


def _parse_units(spec: str, measure: str) -> dict[int, str]:
    """`0:mbar,1:Pa` -> {0: "mbar", 1: "Pa"}.  A malformed pair is ignored."""
    out: dict[int, str] = {}
    for part in (spec or "").split(","):
        if ":" not in part:
            continue
        index, _, unit = part.partition(":")
        try:
            out[int(index)] = canonical_unit(unit, measure)
        except ValueError:
            continue
    return out
