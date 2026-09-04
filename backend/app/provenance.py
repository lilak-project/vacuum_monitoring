"""The written account of where one device's numbers come from.

The complaint this answers is a real one: a chart was on screen and there was
no way to tell, from the chart, which instrument it was reading, which of that
instrument's channels, whether the value had been averaged, what unit the
device itself had reported, or which file the number had been written to. All
of that is known to the service. None of it was being said.

So it is said here. Everything below is read off the running device and the
catalog entry for its type -- nothing is assumed, and where something *is*
assumed (the TIC's unit, say) the caveat is carried through and shown.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from . import catalog
from .config import HISTORY_LIMIT, POLL_INTERVAL
from .monitor import Device, FileSetDevice, RemoteDevice, SerialDevice
from .units import conversion, units_for


def _when(at: float | None) -> str | None:
    if at is None:
        return None
    return dt.datetime.fromtimestamp(at).isoformat(timespec="seconds")


def _duration(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "—"
    if seconds < 90:
        return f"{seconds:.0f} s"
    if seconds < 5400:
        return f"{seconds / 60:.0f} min"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} h"
    return f"{seconds / 86400:.1f} d"


def _file_facts(path: Path) -> dict:
    try:
        stat = path.stat()
    except OSError:
        return {"exists": False, "size": 0, "modified": None}
    return {"exists": True, "size": stat.st_size, "modified": stat.st_mtime}


def describe(device: Device, display_units: dict[int, str] | None = None) -> dict:
    """Everything the UI needs to explain one device, as data plus sentences."""
    display_units = display_units or {}
    spec = catalog.spec(device.device_type)
    origin = device.origin()

    channels = []
    for channel in device.channels:
        channel_spec = (
            spec.channels[channel.index]
            if spec is not None and channel.index < len(spec.channels)
            else None
        )
        target = display_units.get(channel.index, channel.unit)
        factor = conversion(channel.unit, target, device.measure)
        # A device backed by files has no buffer, and reports what is on disk.
        # `as_dict` already knows which it is, so ask it rather than branching.
        counts = channel.as_dict()
        first_at, last_at = counts["first_at"], counts["last_at"]
        channels.append(
            {
                "index": channel.index,
                "label": channel.label,
                "call": channel_spec.call if channel_spec else "",
                "query": channel_spec.query if channel_spec else "",
                "device_unit": channel.unit,
                "display_unit": target,
                "conversion": {
                    "factor": factor.factor,
                    "offset": factor.offset,
                    "identity": factor.is_identity,
                    "description": factor.describe(channel.unit, target),
                },
                "value": channel.latest_value,
                "at": channel.latest_at,
                "at_iso": _when(channel.latest_at),
                "points": counts["points"],
                "estimated": channel.buffer is None,
                "recorded": channel.recorded,
                "dropped": counts["dropped"],
                "first_at": first_at,
                "last_at": last_at,
                "span_text": (
                    _duration(last_at - first_at)
                    if first_at is not None and last_at is not None
                    else "—"
                ),
            }
        )

    if isinstance(device, SerialDevice):
        sampling = {
            "reads": f"every {POLL_INTERVAL:g} s, by this service",
            "plotted": "each sample exactly as the instrument reported it",
            "held": f"the last {_duration(HISTORY_LIMIT * POLL_INTERVAL)} in memory; the rest is in the file",
        }
    elif isinstance(device, FileSetDevice):
        count = len(device.files)
        sampling = {
            "reads": f"nothing — {count} file{'s' if count != 1 else ''} already on disk",
            "plotted": (
                "each row of the files, with the timestamp whatever wrote them recorded; "
                "several runs are joined end to end in time order"
            ),
            "held": (
                "nothing is held in memory — only the window on screen is read, "
                "so a month of files costs the same as one"
            ),
        }
    else:
        sampling = {
            "reads": f"fetched from {getattr(device, 'url', '')} every {POLL_INTERVAL:g} s",
            "plotted": "each new reading the other host reports, with its timestamp",
            "held": f"the last {_duration(HISTORY_LIMIT * POLL_INTERVAL)} in memory; the rest is in the file",
        }

    storage: dict = {"writes": False}
    if device.writer is not None:
        storage = {
            "writes": True,
            # The file appears with the first reading, so a device that has not
            # read yet names the file it will write rather than claiming one.
            "started": device.writer.started,
            "path": str(device.writer.path),
            "filename": device.writer.path.name,
            "rows": device.writer.rows,
            "value_column": "value",
            "unit_column": "unit",
            "format": "vacuum_monitoring",
            **_file_facts(device.writer.path),
        }
    elif isinstance(device, FileSetDevice):
        newest = device.files[-1]
        storage = {
            "writes": False,
            "path": str(device.csv_dir),
            "filename": ", ".join(item["filename"] for item in device.files),
            "file_count": len(device.files),
            "rows": None,
            "value_column": "pressure_raw" if newest["format"] == "cmms" else "value",
            "unit_column": "raw_unit" if newest["format"] == "cmms" else "unit",
            "format": newest["format"],
            **_file_facts(newest["path"]),
        }

    return {
        "id": device.id,
        "name": device.name,
        "device_type": device.device_type,
        "measure": device.measure,
        "source": device.source,
        "status": device.status,
        "last_error": device.last_error,
        "opened_at": device.opened_at,
        "opened_at_iso": _when(device.opened_at),
        "origin": origin,
        "spec": spec.as_dict() if spec else None,
        "channels": channels,
        "sampling": sampling,
        "storage": storage,
        "buffer": {
            "limit": HISTORY_LIMIT,
            "limit_text": _duration(HISTORY_LIMIT * POLL_INTERVAL),
        },
        "health": {
            "polls": device.polls,
            "poll_errors": device.poll_errors,
            "last_poll_at": device.last_poll_at,
            "last_poll_ms": device.last_poll_ms,
        },
        "available_units": units_for(device.measure),
        "explain": _sentences(device, spec, sampling, storage, channels),
    }


def _sentences(device, spec, sampling, storage, channels) -> list[str]:
    """The same account in prose, for the top of the panel.

    One paragraph an operator can read in five seconds and know what they are
    looking at, before any of the tables below it.
    """
    lines: list[str] = []

    if isinstance(device, SerialDevice):
        what = spec.title if spec else device.device_type
        where = f" on **{device.port}**" if device.port else ""
        lines.append(
            f"This tab is **{device.name}** — {what} — opened by this service"
            f"{where} ({spec.link if spec else 'serial'})."
        )
    elif isinstance(device, FileSetDevice):
        count = len(device.files)
        first, last = device.span
        lines.append(
            f"This tab is **{device.name}**, read back from "
            f"**{count} log file{'s' if count != 1 else ''}** in this service's own "
            f"directory, covering {_when(first)} to {_when(last)}. Nothing is being "
            "measured — this is the record."
        )
    elif isinstance(device, RemoteDevice):
        lines.append(
            f"This tab is **{device.name}**, mirrored from **{device.url}**. "
            "The instrument is on that host; the readings are written here."
        )

    if spec is not None:
        lines.append(spec.arithmetic)
        lines.append(f"Unit: {spec.unit_note}")

    lines.append(f"Sampling: read {sampling['reads']}; the chart plots {sampling['plotted']}.")
    lines.append(f"History: {sampling['held']}.")

    if storage.get("writes") and not storage.get("started"):
        lines.append(
            f"Nothing has been read yet, so **{storage['filename']}** has not been "
            "created. It appears with the first reading."
        )
    elif storage.get("writes"):
        lines.append(
            f"Every plotted value is also appended to **{storage['filename']}** "
            f"(column `{storage['value_column']}`), {storage['rows']:,} rows so far."
        )
    elif storage.get("path"):
        which = (
            f"{storage['file_count']} files"
            if storage.get("file_count", 1) > 1
            else f"**{storage['filename']}**"
        )
        lines.append(
            f"The values are read from {which}, column "
            f"`{storage['value_column']}` — nothing is written."
        )
    else:
        lines.append("Nothing is written to disk on this host for this device.")

    converted = [c for c in channels if not c["conversion"]["identity"]]
    if converted:
        first = converted[0]
        lines.append(
            f"The chart is showing {first['display_unit']}, but the device reports "
            f"{first['device_unit']}: {first['conversion']['description']}."
        )

    if spec is not None and spec.caveats:
        lines.extend(f"Caveat: {caveat}" for caveat in spec.caveats)

    return lines
