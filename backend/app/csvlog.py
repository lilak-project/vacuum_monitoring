"""Writing and reading the measurement CSVs.

Two formats exist. Files written here carry a header that names what each
column holds; files written by the previous service (and by the original CMMS
program) call every value `pressure_raw` whatever it measures. The reader takes
both, so nothing already on disk becomes unreadable, and every reader path
reports which format it found -- that answer is shown in the UI rather than
guessed at.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import math
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

#: Written by this service.  `value`/`unit` say what they are.
HEADER = [
    "time",
    "unix_time",
    "elapsed_s",
    "channel",
    "channel_label",
    "value",
    "unit",
    "measure",
    "device_type",
    "device_name",
]

#: Written by cmms-web and the original CMMS program.  Kept readable.
LEGACY_HEADER = [
    "time",
    "unix_time",
    "elapsed_s",
    "channel",
    "pressure_raw",
    "raw_unit",
    "pressure_display",
    "display_unit",
]


def safe_name(name: str) -> str:
    """A device name reduced to something that can be a filename."""
    text = re.sub(r'[\\/:\*\?"<>\|]+', "_", (name or "").strip())
    text = re.sub(r"\s+", "_", text).strip("._ ")
    return text


def is_safe_filename(filename: str) -> bool:
    """True for a bare CSV filename with no path in it."""
    base = os.path.basename(filename)
    return bool(base) and base == filename and base == safe_name(base) and base.lower().endswith(".csv")


def display_name(filename: str) -> str:
    """The device name out of a log filename, in either naming scheme."""
    name = os.path.basename(filename)
    name = re.sub(r"^log_\d{8}_\d{6}_\d+_", "", name)          # cmms-web
    name = re.sub(r"_log\.csv$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"_\d{8}_\d{6}\.csv$", "", name)             # this service
    name = re.sub(r"\.csv$", "", name, flags=re.IGNORECASE)
    return name or os.path.basename(filename)


def new_log_path(csv_dir: Path, device_name: str, device_type: str, started: float) -> Path:
    """`<name>_<when it started>.csv`, in the directory the service logs to."""
    stamp = dt.datetime.fromtimestamp(started).strftime("%Y%m%d_%H%M%S")
    label = safe_name(device_name) or safe_name(device_type) or "device"
    return csv_dir / f"{label}_{stamp}.csv"


class LogWriter:
    """Appends one device's readings to its CSV.

    The file is created by the first reading, not by opening the device. A
    gauge that is switched off, or on the wrong port, therefore leaves nothing
    behind -- the log directory of the service this replaces has eighteen
    header-only CSVs in it, one for every time somebody opened the wrong port.

    Once it does exist the handle is held open for the life of the device
    rather than reopened per row: at one row per channel per second, and eight
    channels on the Lake Shore, reopening is most of the cost of logging.
    """

    def __init__(self, path: Path, device_type: str, device_name: str, measure: str) -> None:
        self.path = path
        self.device_type = device_type
        self.device_name = device_name
        self.measure = measure
        self.rows = 0
        self.first_at: float | None = None
        self._lock = threading.Lock()
        self._handle: object | None = None
        self._writer = None

    def _open(self) -> None:
        """Create the file.  Called under the lock, on the first row only."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = open(self.path, "a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._handle)
        if self._handle.tell() == 0:
            self._writer.writerow(HEADER)
            self._handle.flush()

    @property
    def started(self) -> bool:
        """True once a reading has actually been written."""
        return self._handle is not None

    def append(self, at: float, channel: int, label: str, value: float, unit: str) -> None:
        if not math.isfinite(value):
            return
        with self._lock:
            if self._handle is None:
                self._open()
            if self.first_at is None:
                self.first_at = at
            self._writer.writerow(
                [
                    # The ="..." wrapper is what the previous logs used, and it
                    # stops Excel reinterpreting the timestamp as its own date.
                    '="' + dt.datetime.fromtimestamp(at).strftime("%Y-%m-%d %H:%M:%S") + '"',
                    f"{at:.3f}",
                    f"{at - self.first_at:.3f}",
                    channel,
                    label,
                    f"{value:.12g}",
                    unit,
                    self.measure,
                    self.device_type,
                    self.device_name,
                ]
            )
            self.rows += 1

    def flush(self) -> None:
        with self._lock:
            if self._handle is not None and not self._handle.closed:
                self._handle.flush()

    def close(self) -> None:
        with self._lock:
            if self._handle is not None and not self._handle.closed:
                self._handle.flush()
                self._handle.close()


def _number(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


@dataclass
class ChannelData:
    index: int
    label: str
    unit: str
    times: list[float] = field(default_factory=list)
    values: list[float] = field(default_factory=list)


@dataclass
class LogContents:
    path: Path
    fmt: str  # "vacuum_monitoring" | "cmms" | "unknown"
    measure: str
    device_type: str
    device_name: str
    channels: list[ChannelData]
    rows: int
    scanned: int
    #: Set when only every nth row was read, to keep a huge file affordable.
    stride: int = 1

    @property
    def span(self) -> tuple[float, float] | None:
        starts = [c.times[0] for c in self.channels if c.times]
        ends = [c.times[-1] for c in self.channels if c.times]
        if not starts:
            return None
        return min(starts), max(ends)


def detect_format(fieldnames: list[str] | None) -> str:
    names = set(fieldnames or [])
    if "value" in names and "unit" in names:
        return "vacuum_monitoring"
    if "pressure_raw" in names or "pressure_display" in names:
        return "cmms"
    return "unknown"


#: Timestamps outside this range are not a unix time in seconds, so a row that
#: has one is not a headerless data row.  1990-01-01 to 2100-01-01.
_PLAUSIBLE_TIME = (631_152_000.0, 4_102_444_800.0)


def _looks_like_legacy_row(row: list[str]) -> bool:
    """True when `row` is a cmms data row rather than a header.

    One log on this machine lost its header line -- 429 rows of atmospheric
    pressure that read as an empty file, because the first row was taken as
    the column names. Rather than lose it, a file whose first line parses as
    data is read with the legacy columns assumed.
    """
    if len(row) != len(LEGACY_HEADER):
        return False
    at = _number(row[1])
    if at is None or not (_PLAUSIBLE_TIME[0] < at < _PLAUSIBLE_TIME[1]):
        return False
    return _number(row[4]) is not None


def sniff(first_row: list[str]) -> tuple[list[str], bool]:
    """(column names, whether the first row was the header)."""
    if detect_format(first_row) != "unknown":
        return first_row, True
    if _looks_like_legacy_row(first_row):
        return list(LEGACY_HEADER), False
    return first_row, True


def read_log(
    path: Path,
    start: float | None = None,
    end: float | None = None,
    stride: int = 1,
) -> LogContents:
    """Parse a measurement CSV, optionally only a time window of it.

    Streams the file: the 60 MB logs in this directory would be several hundred
    megabytes of Python objects if they were read whole.
    """
    stride = max(1, int(stride))
    channels: dict[int, ChannelData] = {}
    fmt = "unknown"
    measure = ""
    device_type = ""
    device_name = ""
    rows = 0
    scanned = 0

    with open(path, newline="", encoding="utf-8", errors="replace") as handle:
        probe = csv.reader(handle)
        first = next(probe, [])
        fieldnames, had_header = sniff(first)
        fmt = detect_format(fieldnames)
        handle.seek(0)
        if had_header:
            handle.readline()

        # Column positions, resolved once. The hot loop below splits on commas
        # rather than going through csv.DictReader: these files are written by
        # two known programs, neither of which puts a comma inside a field, and
        # a month of one channel is 2.6 million rows -- building a dict for
        # each one costs seconds that show up as a slow chart. Any line whose
        # field count does not match falls back to the real parser, so a device
        # name with a comma in it is read correctly rather than dropped.
        width = len(fieldnames)
        at_col = fieldnames.index("unix_time")
        channel_col = fieldnames.index("channel") if "channel" in fieldnames else -1
        if fmt == "cmms":
            value_col = fieldnames.index("pressure_raw") if "pressure_raw" in fieldnames else -1
            spare_col = (
                fieldnames.index("pressure_display") if "pressure_display" in fieldnames else -1
            )
            unit_col = fieldnames.index("raw_unit") if "raw_unit" in fieldnames else -1
            label_col = measure_col = type_col = name_col = -1
            measure = measure or "pressure"
        else:
            value_col = fieldnames.index("value") if "value" in fieldnames else -1
            spare_col = -1
            unit_col = fieldnames.index("unit") if "unit" in fieldnames else -1
            label_col = fieldnames.index("channel_label") if "channel_label" in fieldnames else -1
            measure_col = fieldnames.index("measure") if "measure" in fieldnames else -1
            type_col = fieldnames.index("device_type") if "device_type" in fieldnames else -1
            name_col = fieldnames.index("device_name") if "device_name" in fieldnames else -1
        if at_col < 0 or value_col < 0:
            return LogContents(path, fmt, measure or "pressure", "", "", [], 0, 0, stride)

        cell = lambda parts, col: parts[col] if 0 <= col < len(parts) else ""  # noqa: E731

        for line in handle:
            parts = line.rstrip("\r\n").split(",")
            if len(parts) != width:
                parsed = next(csv.reader([line]), None)
                if parsed is None or len(parsed) != width:
                    continue
                parts = parsed
            scanned += 1

            at = _number(parts[at_col])
            if at is None:
                continue
            if start is not None and at < start:
                continue
            if end is not None and at > end:
                break  # rows are written in time order
            rows += 1
            # Decided before anything is converted: a skipped row costs one
            # split and one comparison.
            if stride > 1 and (rows - 1) % stride:
                continue

            value = _number(cell(parts, value_col))
            if value is None and spare_col >= 0:
                value = _number(cell(parts, spare_col))
            if value is None:
                continue
            unit = cell(parts, unit_col) or ("Torr" if fmt == "cmms" else "")
            label = cell(parts, label_col)
            if measure_col >= 0 and not measure:
                measure = cell(parts, measure_col)
            if type_col >= 0 and not device_type:
                device_type = cell(parts, type_col)
            if name_col >= 0 and not device_name:
                device_name = cell(parts, name_col)

            index = int(_number(cell(parts, channel_col)) or 1)
            channel = channels.get(index)
            if channel is None:
                channel = channels[index] = ChannelData(index=index, label=label, unit=unit)
            elif not channel.label and label:
                channel.label = label
            channel.times.append(at)
            channel.values.append(value)

    # Labels are left empty rather than filled with "CH1": a legacy file has
    # none, and the caller can name the channel from the catalog entry for the
    # device the file belongs to.
    ordered = [channels[key] for key in sorted(channels)]
    return LogContents(
        path=path,
        fmt=fmt,
        measure=measure or "pressure",
        device_type=device_type or display_name(path.name),
        device_name=device_name or display_name(path.name),
        channels=ordered,
        rows=rows,
        scanned=scanned,
        stride=stride,
    )


def scan_meta(path: Path, sample_bytes: int = 65536) -> dict:
    """Header, first and last timestamp, and a row estimate, without a full read.

    The last line is found by seeking to the end, so this stays constant-time
    on the multi-gigabyte logs a long run leaves behind.
    """
    size = path.stat().st_size
    with open(path, "rb") as handle:
        header_line = handle.readline()
        parsed_first = next(csv.reader([header_line.decode("utf-8", "replace")]), [])
        header, had_header = sniff(parsed_first)
        fmt = detect_format(header)
        if not had_header:
            # The first line is data; rewind so it is not skipped.
            handle.seek(0)
            header_line = b""

        first_row = None
        chunk = handle.read(sample_bytes).decode("utf-8", "replace").splitlines()
        for line in chunk:
            parsed = next(csv.reader([line]), None)
            if parsed and len(parsed) == len(header):
                first_row = dict(zip(header, parsed))
                break

        last_row = None
        if size > 0:
            handle.seek(max(0, size - sample_bytes))
            tail = handle.read().decode("utf-8", "replace").splitlines()
            for line in reversed(tail):
                parsed = next(csv.reader([line]), None)
                if parsed and len(parsed) == len(header) and parsed[0] != header[0]:
                    # (header[0] is "time"; a data row never repeats it)
                    last_row = dict(zip(header, parsed))
                    break

    # Which channels the file holds, and what they are called, off the head
    # sample -- a device writes one row per channel per instant, so a few
    # kilobytes covers even the eight-channel Lake Shore.
    channels: dict[int, dict] = {}
    legacy = fmt == "cmms"
    for line in chunk:
        parsed = next(csv.reader([line]), None)
        if not parsed or len(parsed) != len(header) or parsed[0] == header[0]:
            continue
        fields = dict(zip(header, parsed))
        if _number(fields.get("unix_time")) is None:
            continue
        try:
            index = int(_number(fields.get("channel")) or 1)
        except (TypeError, ValueError):
            index = 1
        channels.setdefault(
            index,
            {
                "index": index - 1 if index > 0 else 0,
                "label": (fields.get("channel_label") or "") if not legacy else "",
                "unit": (fields.get("raw_unit") if legacy else fields.get("unit")) or "",
            },
        )

    first_at = _number((first_row or {}).get("unix_time"))
    last_at = _number((last_row or {}).get("unix_time"))
    last_value = _number(
        (last_row or {}).get("pressure_raw") if fmt == "cmms" else (last_row or {}).get("value")
    )
    # Every row of one file has the same shape, so the mean row length off the
    # head is a good enough estimate to decide a stride from.
    header_len = len(header_line)
    row_len = max(1, (len(chunk[0]) + 1) if chunk else 1)

    estimated_rows = max(0, int((size - header_len) / row_len))

    return {
        "format": fmt,
        "header": header,
        "has_header_row": had_header,
        "size": size,
        "first_at": first_at,
        "last_at": last_at,
        "estimated_rows": estimated_rows,
        "device_type": (last_row or {}).get("device_type") or "",
        "device_name": (last_row or {}).get("device_name") or display_name(path.name),
        "measure": (last_row or {}).get("measure") or ("pressure" if fmt == "cmms" else ""),
        "channels": [channels[key] for key in sorted(channels)],
        "last_value": last_value,
        "last_unit": (
            (last_row or {}).get("raw_unit") if fmt == "cmms" else (last_row or {}).get("unit")
        )
        or "",
    }


#: Written by tools/import_logs.py beside the files it copies in.
IMPORT_MANIFEST = ".imported.json"


def import_record(csv_dir: Path, filename: str) -> dict | None:
    """Where a log was copied in from, when it did not start life here.

    A log that arrived from another machine's install should say so rather
    than looking like one this service wrote.
    """
    path = csv_dir / IMPORT_MANIFEST
    if not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = manifest.get(filename) if isinstance(manifest, dict) else None
    return entry if isinstance(entry, dict) else None


def list_logs(csv_dir: Path) -> list[dict]:
    """Every CSV in the log directory, newest first."""
    if not csv_dir.is_dir():
        return []
    found = []
    for entry in csv_dir.iterdir():
        if entry.is_file() and entry.suffix.lower() == ".csv":
            stat = entry.stat()
            found.append(
                {
                    "filename": entry.name,
                    "name": display_name(entry.name),
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                }
            )
    return sorted(found, key=lambda item: item["modified"], reverse=True)
