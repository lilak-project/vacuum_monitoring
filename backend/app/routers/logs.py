"""The CSV logs: what is on disk, and how to plot any window of one."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import catalog, csvlog
from ..config import DEFAULT_MAX_POINTS, MAX_MAX_POINTS
from ..monitor import monitor
from ..series import decimate
from ..units import canonical_unit, conversion
from ._helpers import run_io

router = APIRouter(prefix="/api/logs", tags=["logs"])

#: Rows a windowed read will parse before it starts skipping.  A day of eight
#: Lake Shore channels is 700 000 rows; reading all of them to draw 2 000
#: points is work nobody sees.
_STRIDE_BUDGET = 400_000


def _path(filename: str) -> Path:
    if not csvlog.is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="That is not a log filename")
    path = monitor.csv_dir / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"No log named {filename}")
    return path


@router.get("")
async def list_logs() -> dict:
    """Every CSV in the directory this service is reading, newest first."""
    return {
        "csv_dir": str(monitor.csv_dir),
        "mode": monitor.mode,
        "writing": monitor.mode == "live",
        "logs": await run_io(csvlog.list_logs, monitor.csv_dir),
    }


@router.get("/{filename}/meta")
async def log_meta(filename: str) -> dict:
    """Format, time span and size, read without parsing the whole file."""
    path = _path(filename)
    meta = await run_io(csvlog.scan_meta, path)
    span = None
    if meta["first_at"] is not None and meta["last_at"] is not None:
        span = meta["last_at"] - meta["first_at"]
    imported = await run_io(csvlog.import_record, monitor.csv_dir, filename)
    return {
        "filename": filename,
        "name": csvlog.display_name(filename),
        "span_seconds": span,
        # None for a log this service wrote itself.
        "imported_from": imported.get("source") if imported else None,
        "imported_at": imported.get("imported_at") if imported else None,
        "format_label": {
            "vacuum_monitoring": "written by this service",
            "cmms": "written by cmms-web or the original CMMS program",
            "unknown": "unrecognised header",
        }.get(meta["format"], meta["format"]),
        **meta,
    }


@router.get("/{filename}/series")
async def log_series(
    filename: str,
    start: float | None = Query(None, alias="from"),
    end: float | None = Query(None, alias="to"),
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=2, le=MAX_MAX_POINTS),
    units: str = Query(""),
) -> dict:
    """Plot a window of a saved log, on the same terms as a live device."""
    path = _path(filename)
    return await run_io(_read_series, path, filename, start, end, max_points, units)


def _read_series(path, filename, start, end, max_points, units) -> dict:
    meta = csvlog.scan_meta(path)
    measure = meta.get("measure") or "pressure"

    # Estimate how much of the file the window covers, and skip rows if it is
    # far more than the chart can use.
    stride = 1
    rows = meta.get("estimated_rows") or 0
    first_at, last_at = meta.get("first_at"), meta.get("last_at")
    if rows and first_at is not None and last_at is not None and last_at > first_at:
        fraction = 1.0
        if start is not None or end is not None:
            lo = max(first_at, start if start is not None else first_at)
            hi = min(last_at, end if end is not None else last_at)
            fraction = max(0.0, hi - lo) / (last_at - first_at)
        expected = rows * fraction
        if expected > _STRIDE_BUDGET:
            stride = int(expected // _STRIDE_BUDGET) + 1

    contents = csvlog.read_log(path, start=start, end=end, stride=stride)
    display: dict[int, str] = {}
    for part in (units or "").split(","):
        if ":" in part:
            index, _, unit = part.partition(":")
            try:
                display[int(index)] = canonical_unit(unit, measure)
            except ValueError:
                pass

    series = []
    for data in contents.channels:
        index = data.index - 1 if data.index > 0 else 0
        times, values, was_decimated = decimate(data.times, data.values, max_points)
        target = display.get(index, data.unit)
        factor = conversion(data.unit, target, measure)
        if not factor.is_identity:
            values = [value * factor.factor + factor.offset for value in values]
        series.append(
            {
                "index": index,
                "label": data.label or catalog.channel_label(contents.device_type, index),
                "unit": target,
                "device_unit": data.unit,
                "conversion": {
                    "factor": factor.factor,
                    "offset": factor.offset,
                    "identity": factor.is_identity,
                    "description": factor.describe(data.unit, target),
                },
                "t": times,
                "v": values,
                "total": len(data.times),
                "decimated": was_decimated or stride > 1,
            }
        )

    return {
        "id": filename,
        "name": csvlog.display_name(filename),
        "measure": measure,
        "source": "file",
        "format": contents.fmt,
        "device_type": contents.device_type,
        "start": start,
        "end": end,
        "max_points": max_points,
        # Said out loud rather than hidden: a chart drawn from every nth row is
        # a different claim from one drawn from all of them.
        "row_stride": stride,
        "rows_in_window": contents.rows,
        "series": series,
    }


@router.get("/{filename}/download")
async def download_log(filename: str) -> FileResponse:
    """The file itself, for anyone who would rather have the numbers."""
    return FileResponse(_path(filename), media_type="text/csv", filename=filename)
