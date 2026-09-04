"""The measurement loop, and everything that can appear as a tab.

Three kinds of thing feed a chart, and they differ only in where a sample comes
from:

- a **serial** instrument this service opens and reads once a second,
- a **remote** service on another host, whose readings are fetched and then
  written to this machine's own log like any other,
- a **file set** — CSVs already in the log directory, read back off disk.

The first two hold their samples in a ring buffer, because they are producing
new ones and something has to catch them. The third does not hold anything: a
month of readings is 2.6 million samples per channel, and there is no reason to
carry that in memory when the window a chart is showing can be read from the
file it is already in. So `series()` is the interface, and how it is answered
is the device's business.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import catalog, csvlog
from .config import (
    FILE_ROW_BUDGET,
    HISTORY_LIMIT,
    LOG_ROOT,
    POLL_INTERVAL,
)
from .drivers_bridge import DEVICE_CLASSES, measure_of_driver
from .series import Buffer, decimate
from .store import record_log_file
from .units import canonical_unit

log = logging.getLogger(__name__)

#: What the whole service is reading right now.  The two are exclusive: a panel
#: that could mix a live gauge with a file is a panel where "what am I looking
#: at" has no single answer.
MODES = ("live", "attach")


def _slug(text: str) -> str:
    out = []
    previous_dash = False
    for char in text:
        if char.isalnum():
            out.append(char.lower())
            previous_dash = False
        elif not previous_dash:
            out.append("-")
            previous_dash = True
    return "".join(out).strip("-") or "device"


def fetch_json(url: str, timeout: float = 3.0) -> object:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as err:
        raise RuntimeError(f"{url} did not answer: {err.reason}") from err


class Channel:
    """One measurement of one device.

    `buffer` is set for a device that is producing samples now; a device backed
    by files leaves it None and fills in the counts from what is on disk.
    """

    __slots__ = (
        "index", "label", "unit", "buffer", "latest_value", "latest_at",
        "recorded", "points", "first_at", "last_at",
    )

    def __init__(self, index: int, label: str, unit: str, buffered: bool = True) -> None:
        self.index = index
        self.label = label
        self.unit = unit
        self.buffer: Buffer | None = Buffer(HISTORY_LIMIT) if buffered else None
        self.latest_value: float | None = None
        self.latest_at: float | None = None
        self.recorded = 0
        # Only used when there is no buffer; otherwise read off it.
        self.points = 0
        self.first_at: float | None = None
        self.last_at: float | None = None

    def record(self, at: float, value: float | None) -> bool:
        if value is None or not math.isfinite(value):
            return False
        if self.buffer is not None:
            self.buffer.append(at, value)
        self.latest_value = value
        self.latest_at = at
        self.recorded += 1
        return True

    def as_dict(self) -> dict:
        if self.buffer is not None:
            span = self.buffer.span
            points, first_at, last_at = len(self.buffer), (span[0] if span else None), (span[1] if span else None)
            dropped = self.buffer.dropped
        else:
            points, first_at, last_at, dropped = self.points, self.first_at, self.last_at, 0
        return {
            "index": self.index,
            "label": self.label,
            "unit": self.unit,
            "value": self.latest_value,
            "at": self.latest_at,
            "points": points,
            "recorded": self.recorded,
            "dropped": dropped,
            "first_at": first_at,
            "last_at": last_at,
        }


class Device:
    """Common behaviour of everything that can appear as a tab in the UI."""

    #: "serial" | "remote" | "file"
    source = "serial"
    #: True for something that is producing new readings.
    live = True

    def __init__(self, device_id: str, name: str, device_type: str, measure: str) -> None:
        self.id = device_id
        self.name = name
        self.device_type = device_type
        self.measure = measure
        self.profile_id: str | None = None
        self.channels: list[Channel] = []
        self.status = "closed"
        self.last_error: str | None = None
        self.opened_at: float | None = None
        self.lock = threading.RLock()
        self.polls = 0
        self.poll_errors = 0
        self.last_poll_at: float | None = None
        self.last_poll_ms: float | None = None
        self.writer: csvlog.LogWriter | None = None

    # -- provided by each kind of device ---------------------------------
    def read(self, now: float) -> list[float | None]:
        raise NotImplementedError

    def origin(self) -> dict:
        raise NotImplementedError

    def series(
        self, start: float | None, end: float | None, max_points: int
    ) -> list[tuple[Channel, list[float], list[float], int, bool]]:
        """The samples of every channel in a window, already decimated."""
        out = []
        for channel in self.channels:
            if channel.buffer is None:
                out.append((channel, [], [], 0, False))
                continue
            times, values = channel.buffer.window(start, end)
            total = len(times)
            times, values, was_decimated = decimate(times, values, max_points)
            out.append((channel, times, values, total, was_decimated))
        return out

    def close(self) -> None:
        if self.writer is not None:
            self.writer.close()
            self.writer = None
        self.status = "closed"

    # -- shared ----------------------------------------------------------
    def poll(self, now: float) -> None:
        started = time.perf_counter()
        with self.lock:
            try:
                values = self.read(now)
                self.status = "open"
                self.last_error = None
            except Exception as err:  # a bad cable must not stop the loop
                self.poll_errors += 1
                self.status = "error"
                self.last_error = f"{type(err).__name__}: {err}"
                log.warning("%s: read failed: %s", self.id, self.last_error)
                return
            finally:
                self.polls += 1
                self.last_poll_at = now
                self.last_poll_ms = (time.perf_counter() - started) * 1000.0
            for channel, value in zip(self.channels, values):
                if channel.record(now, value):
                    self._write_log(now, channel, value)

    def _write_log(self, at: float, channel: Channel, value: float) -> None:
        if self.writer is not None:
            self.writer.append(at, channel.index + 1, channel.label, value, channel.unit)

    def snapshot(self) -> dict:
        """Metadata and the latest reading.  Never history -- that is a query."""
        with self.lock:
            return {
                "id": self.id,
                "name": self.name,
                "device_type": self.device_type,
                "measure": self.measure,
                "source": self.source,
                "profile_id": self.profile_id,
                "status": self.status,
                "last_error": self.last_error,
                "opened_at": self.opened_at,
                "channels": [channel.as_dict() for channel in self.channels],
                "log_path": str(self.writer.path) if self.writer else None,
                "log_rows": self.writer.rows if self.writer else 0,
                "polls": self.polls,
                "poll_errors": self.poll_errors,
                "last_poll_at": self.last_poll_at,
                "last_poll_ms": self.last_poll_ms,
            }


class SerialDevice(Device):
    """An instrument this service opened on a serial port."""

    source = "serial"

    def __init__(
        self,
        device_type: str,
        port: str,
        name: str,
        csv_dir: Path,
        history_files: list[str] | None = None,
    ) -> None:
        cls = DEVICE_CLASSES.get(device_type)
        if cls is None:
            raise ValueError(f"Unknown device type: {device_type}")
        self.port = port
        started = time.time()
        driver = cls(name or device_type, port)
        measure = measure_of_driver(driver, device_type)
        super().__init__(_slug(f"{device_type}-{port}"), name or device_type, device_type, measure)
        self.driver = driver
        self.opened_at = started

        count = max(1, int(getattr(driver, "n_meas", 1)))
        for index in range(count):
            unit = canonical_unit(self._read_unit(index), measure)
            self.channels.append(Channel(index, catalog.channel_label(device_type, index), unit))

        self.status = "open" if self._is_open() else "closed"
        self.writer = csvlog.LogWriter(
            csvlog.new_log_path(csv_dir, self.name, device_type, started),
            device_type,
            self.name,
            measure,
        )
        # The logs to read back for anything older than the buffer. Continuing
        # a profile puts its earlier runs in here; starting fresh leaves only
        # this run's own file, which is what makes a run longer than the
        # buffer's 24 hours still scrollable back to its beginning.
        self.history_files = [*(history_files or []), self.writer.path.name]
        self.history = FileHistory(csv_dir, self.history_files)
        self.continued = bool(history_files)

    def _read_unit(self, index: int) -> str:
        try:
            return str(self.driver.GetUnit(index) or "")
        except Exception:
            return ""

    def _is_open(self) -> bool:
        try:
            return bool(self.driver.is_open())
        except Exception:
            return False

    #: How often the device's own log is re-scanned, so its span stays current
    #: once the run is longer than the buffer.  Cheap: a seek to each end.
    _HISTORY_RESCAN = 300.0

    def poll(self, now: float) -> None:
        super().poll(now)
        if now - getattr(self, "_history_scanned_at", 0.0) > self._HISTORY_RESCAN:
            self._history_scanned_at = now
            self.history.refresh_newest()

    def read(self, now: float) -> list[float | None]:
        if not self._is_open():
            # The gauge may just have been power-cycled; try to pick it back up.
            self.driver.open()
            if not self._is_open():
                raise RuntimeError(f"{self.port} is not open")
        values: list[float | None] = []
        for channel in self.channels:
            raw = self.driver.GetMeasure(channel.index)
            try:
                value = float(raw)
            except (TypeError, ValueError):
                value = math.nan
            values.append(value if math.isfinite(value) else None)
            # A gauge can be switched between Torr and mbar while running, and
            # the service this replaces read the unit once and then labelled 30
            # hours of mbar as Torr. Reading it every poll is what caught that.
            unit = canonical_unit(self._read_unit(channel.index), self.measure)
            if unit and unit != channel.unit:
                log.info("%s ch%d: unit changed %s -> %s", self.id, channel.index, channel.unit, unit)
                channel.unit = unit
        return values

    def series(self, start, end, max_points):
        """Files for the old part of the window, the buffer for the recent part.

        The buffer holds a day; the files hold everything. Rather than make the
        operator know which is which, the two are stitched at the moment the
        buffer begins -- so scrolling back past midnight simply keeps working,
        and with Continue it keeps working past the start of this run.
        """
        edges = [
            channel.buffer.span[0]
            for channel in self.channels
            if channel.buffer is not None and channel.buffer.span is not None
        ]
        buffer_start = min(edges) if edges else None

        from_files: dict[int, tuple[list[float], list[float]]] = {}
        stride = 1
        wants_history = self.history and (start is None or buffer_start is None or start < buffer_start)
        if wants_history:
            # A hair before the buffer's first sample, so the boundary reading
            # is not counted twice.
            file_end = None if buffer_start is None else buffer_start - 0.001
            if end is not None and (file_end is None or end < file_end):
                file_end = end
            from_files, stride = self.history.read(start, file_end)

        out = []
        for channel in self.channels:
            times, values = from_files.get(channel.index, ([], []))
            if channel.buffer is not None:
                lo = start if buffer_start is None else max(start or buffer_start, buffer_start)
                live_t, live_v = channel.buffer.window(lo, end)
                times = [*times, *live_t]
                values = [*values, *live_v]
            times, values = _in_time_order(times, values)
            total = len(times)
            times, values, was_decimated = decimate(times, values, max_points)
            out.append((channel, times, values, total, was_decimated or stride > 1))
        return out

    def snapshot(self) -> dict:
        """As the base class, but reaching back to where the files start.

        The buffer holds a day. The files hold the rest, and `series` stitches
        them, so the chart is allowed to scroll into them -- which means the
        earliest timestamp a channel reports has to be the earliest there is,
        not the earliest still in memory. Otherwise the axis clamps at midnight
        and the history Continue just loaded is unreachable.
        """
        data = super().snapshot()
        span = self.history.span
        if span is not None:
            for channel in data["channels"]:
                first = channel["first_at"]
                channel["first_at"] = span[0] if first is None else min(first, span[0])
        return data

    def origin(self) -> dict:
        spec = catalog.spec(self.device_type)
        where = f" on {self.port}" if self.port else ""
        earlier = len(self.history_files) - 1
        return {
            "kind": "serial",
            "summary": (
                f"Read directly from {self.device_type}{where} by this service."
                + (
                    f" Continuing from {earlier} earlier log"
                    f"{'s' if earlier != 1 else ''}, so the chart reaches back past this run."
                    if self.continued
                    else ""
                )
            ),
            "port": self.port,
            "continued": self.continued,
            "filenames": list(self.history_files),
            "device_spec": spec.as_dict() if spec else None,
        }

    def close(self) -> None:
        try:
            self.driver.close()
        except Exception:
            pass
        super().close()


class RemoteDevice(Device):
    """One device of another host's service, mirrored and logged here."""

    source = "remote"

    def __init__(self, url: str, remote_id: str, name: str, device_type: str,
                 measure: str, csv_dir: Path) -> None:
        super().__init__(f"remote-{_slug(remote_id)}", name, device_type or "Remote", measure)
        self.url = url
        self.remote_id = remote_id
        self.status = "open"
        self.opened_at = time.time()
        # The readings are written here too -- the point of mirroring is that
        # this machine ends up with the record.
        self.writer = csvlog.LogWriter(
            csvlog.new_log_path(csv_dir, name, device_type or "remote", self.opened_at),
            device_type or "Remote",
            name,
            measure,
        )

    def read(self, now: float) -> list[float | None]:
        # Filled in by the RemoteSource, which fetches the whole host at once.
        return [channel.latest_value for channel in self.channels]

    def apply(self, now: float, channels: list[dict]) -> None:
        """Take one fetched snapshot of this device."""
        with self.lock:
            self.polls += 1
            self.last_poll_at = now
            for entry in channels:
                index = int(entry.get("index", 0))
                while len(self.channels) <= index:
                    self.channels.append(
                        Channel(len(self.channels), entry.get("label") or f"CH{index + 1}", "")
                    )
                channel = self.channels[index]
                channel.unit = canonical_unit(entry.get("unit") or channel.unit, self.measure)
                at, value = entry.get("at"), entry.get("value")
                if at is None or value is None:
                    continue
                # The remote clock stamps the sample; a repeat is not a new one.
                if channel.latest_at is not None and float(at) <= channel.latest_at:
                    continue
                if channel.record(float(at), float(value)):
                    self._write_log(float(at), channel, float(value))

    def origin(self) -> dict:
        return {
            "kind": "remote",
            "summary": (
                f"Mirrored from {self.url}, where it is device {self.remote_id}. "
                "The instrument is on that host; the readings are logged on this one."
            ),
            "url": self.url,
            "remote_id": self.remote_id,
            "device_spec": (catalog.spec(self.device_type).as_dict()
                            if catalog.spec(self.device_type) else None),
        }


class RemoteSource:
    """One connected remote host, and the devices it is lending us.

    The host is fetched once per tick and the answer distributed, rather than
    each mirrored device asking separately -- one request either way, however
    many gauges are on the other end.
    """

    def __init__(self, profile: dict, csv_dir: Path) -> None:
        self.profile_id = profile["id"]
        self.name = profile["name"]
        self.url = profile["url"]
        self.csv_dir = csv_dir
        self.devices: dict[str, RemoteDevice] = {}
        self.last_error: str | None = None

    def poll(self, now: float) -> None:
        try:
            entries = self._fetch()
            self.last_error = None
        except Exception as err:
            self.last_error = str(err)
            for device in self.devices.values():
                device.status = "error"
                device.last_error = self.last_error
            return

        for entry in entries:
            device = self.devices.get(str(entry["id"]))
            if device is None:
                device = RemoteDevice(
                    self.url, f"{self.profile_id}-{entry['id']}",
                    f"{self.name} · {entry['name']}",
                    entry["device_type"], entry["measure"], self.csv_dir,
                )
                device.profile_id = self.profile_id
                self.devices[str(entry["id"])] = device
            device.apply(now, entry["channels"])
            device.status = "open"
            device.last_error = None

    def _fetch(self) -> list[dict]:
        """Read the other host, in this service's shape or the older cmms-web's."""
        try:
            payload = fetch_json(f"{self.url}/api/devices")
            if isinstance(payload, list):
                return [
                    {
                        "id": item.get("id"),
                        "name": item.get("name") or str(item.get("id")),
                        "device_type": item.get("device_type") or "",
                        "measure": item.get("measure") or "pressure",
                        "channels": item.get("channels") or [],
                    }
                    for item in payload
                ]
        except RuntimeError:
            pass  # an older host; fall through to the cmms-web endpoint

        state = fetch_json(f"{self.url}/api/state")
        if not isinstance(state, dict):
            raise RuntimeError(f"{self.url} answered something that is not a state document")
        out = []
        for item in state.get("devices", []):
            measure = "temperature" if item.get("measure_type") == "Temp" else "pressure"
            units = item.get("units") or []
            at = item.get("latest_timestamp")
            device_type = item.get("device_type") or ""
            out.append({
                "id": item.get("id"),
                "name": item.get("name") or str(item.get("id")),
                "device_type": device_type,
                "measure": measure,
                "channels": [
                    {
                        "index": index,
                        "label": catalog.channel_label(device_type, index),
                        "unit": units[index] if index < len(units) else "",
                        "value": value,
                        "at": at,
                    }
                    for index, value in enumerate(item.get("latest_values") or [])
                ],
            })
        return out

    def close(self) -> None:
        for device in self.devices.values():
            device.close()
        self.devices.clear()


class FileHistory:
    """A set of logs on disk, read a window at a time.

    Shared by the two things that need it: a tab made of saved files, and a
    live device that is being asked about a time before its buffer starts.
    Nothing is held — a query opens only the files the window touches, reads
    only the rows inside it, and skips rows when even that is more than a chart
    can use. A hundred days of logs therefore costs what one run costs.
    """

    def __init__(self, csv_dir: Path, filenames: list[str]) -> None:
        self.csv_dir = csv_dir
        self.files: list[dict] = []
        for filename in filenames:
            path = csv_dir / filename
            if not path.is_file():
                continue  # a log that has been moved or deleted since
            try:
                meta = csvlog.scan_meta(path)
            except OSError:
                continue
            if meta["first_at"] is None:
                continue  # nothing in it
            self.files.append({"filename": filename, "path": path, **meta})
        self.files.sort(key=lambda item: item["first_at"])

    def __bool__(self) -> bool:
        return bool(self.files)

    @property
    def span(self) -> tuple[float, float] | None:
        if not self.files:
            return None
        return (
            min(item["first_at"] for item in self.files),
            max(item["last_at"] for item in self.files if item["last_at"] is not None),
        )

    @property
    def estimated_rows(self) -> int:
        return sum(item["estimated_rows"] for item in self.files)

    def channel_meta(self) -> list[dict]:
        """The union of the channels across every file, lowest index first."""
        found: dict[int, dict] = {}
        for item in self.files:
            for entry in item["channels"]:
                index = int(entry["index"])
                current = found.setdefault(index, dict(entry))
                if entry["unit"]:
                    current["unit"] = entry["unit"]
                if entry["label"] and not current["label"]:
                    current["label"] = entry["label"]
        return [found[key] for key in sorted(found)]

    def refresh_newest(self) -> bool:
        """Re-scan the last file in case something is still writing it."""
        if not self.files:
            return False
        newest = self.files[-1]
        try:
            if newest["path"].stat().st_size == newest["size"]:
                return False
            self.files[-1] = {
                "filename": newest["filename"],
                "path": newest["path"],
                **csvlog.scan_meta(newest["path"]),
            }
        except OSError:
            return False
        return True

    def stride_for(self, start: float | None, end: float | None) -> int:
        """How many rows to skip so a wide window stays affordable."""
        expected = 0.0
        for item in self.files:
            lo, hi = item["first_at"], item["last_at"]
            if hi is None or hi <= lo:
                continue
            window_lo = max(lo, start if start is not None else lo)
            window_hi = min(hi, end if end is not None else hi)
            if window_hi <= window_lo:
                continue
            expected += item["estimated_rows"] * (window_hi - window_lo) / (hi - lo)
        return int(expected // FILE_ROW_BUDGET) + 1 if expected > FILE_ROW_BUDGET else 1

    def read(
        self, start: float | None, end: float | None
    ) -> tuple[dict[int, tuple[list[float], list[float]]], int]:
        """Samples per channel index in the window, and the stride that was used."""
        stride = self.stride_for(start, end)
        gathered: dict[int, tuple[list[float], list[float]]] = {}
        for item in self.files:
            lo, hi = item["first_at"], item["last_at"]
            if start is not None and hi is not None and hi < start:
                continue
            if end is not None and lo is not None and lo > end:
                continue
            contents = csvlog.read_log(item["path"], start=start, end=end, stride=stride)
            for data in contents.channels:
                index = data.index - 1 if data.index > 0 else 0
                bucket = gathered.setdefault(index, ([], []))
                bucket[0].extend(data.times)
                bucket[1].extend(data.values)
        return gathered, stride


def _in_time_order(times: list[float], values: list[float]) -> tuple[list[float], list[float]]:
    """Sort a concatenation by time, if it is not already.

    Runs usually follow one another, but they do not have to: one of the
    imported logs holds a single row from inside another one's window. Left
    alone that hands the chart a line that doubles back on itself, and
    decimation assumes time order.
    """
    if all(times[i] <= times[i + 1] for i in range(len(times) - 1)):
        return times, values
    order = sorted(range(len(times)), key=times.__getitem__)
    return [times[i] for i in order], [values[i] for i in order]


class FileSetDevice(Device):
    """One or more logs from this service's own directory, read as one trace.

    Files are ordered by their first sample, so several runs of the same gauge
    join into one continuous line across the gaps between them.
    """

    source = "file"
    live = False

    def __init__(self, name: str, filenames: list[str], csv_dir: Path) -> None:
        self.csv_dir = csv_dir
        self.history = FileHistory(csv_dir, filenames)
        if not self.history:
            raise ValueError("None of those files have any readings in them")

        files = self.history.files
        newest = files[-1]
        device_type = next((item["device_type"] for item in files if item["device_type"]), "")
        measure = next((item["measure"] for item in files if item["measure"]), "") or (
            catalog.measure_of(device_type)
        )
        super().__init__(
            f"file-{_slug('-'.join(filenames))[:60]}",
            name or csvlog.display_name(newest["filename"]),
            device_type or "CSV",
            measure,
        )
        self.status = "attached"
        self.opened_at = time.time()

        for entry in self.history.channel_meta():
            index = int(entry["index"])
            self.channels.append(
                Channel(
                    index,
                    entry["label"] or catalog.channel_label(self.device_type, index),
                    canonical_unit(entry["unit"], measure),
                    buffered=False,
                )
            )
        self._describe()

    @property
    def files(self) -> list[dict]:
        return self.history.files

    def _describe(self) -> None:
        """Fill in the counts and the last reading from what is on disk."""
        span = self.history.span
        if span is None:
            return
        newest = self.history.files[-1]
        per_channel = max(1, len(self.channels))
        for channel in self.channels:
            channel.first_at, channel.last_at = span
            # An estimate, and said to be one wherever it is shown: counting
            # exactly would mean reading every file.
            channel.points = self.history.estimated_rows // per_channel
            channel.latest_value = newest["last_value"]
            channel.latest_at = newest["last_at"]

    @property
    def span(self) -> tuple[float, float]:
        return self.history.span or (self.opened_at or 0.0, self.opened_at or 0.0)

    def read(self, now: float) -> list[float | None]:
        """Files do not produce readings; nothing polls this."""
        return [channel.latest_value for channel in self.channels]

    def poll(self, now: float) -> None:
        """Re-scan only the newest file, in case something is still writing it."""
        if self.history.refresh_newest():
            self._describe()
        self.polls += 1
        self.last_poll_at = now

    def series(self, start, end, max_points):
        gathered, stride = self.history.read(start, end)
        out = []
        for channel in self.channels:
            times, values = gathered.get(channel.index, ([], []))
            times, values = _in_time_order(times, values)
            total = len(times)
            times, values, was_decimated = decimate(times, values, max_points)
            out.append((channel, times, values, total, was_decimated or stride > 1))
        return out

    def origin(self) -> dict:
        names = [item["filename"] for item in self.history.files]
        return {
            "kind": "file",
            "summary": (
                f"Read from {len(names)} log file{'s' if len(names) != 1 else ''} in this "
                "service's own directory. Nothing is being measured — this is what was "
                "recorded, read back off disk a window at a time."
            ),
            "path": str(self.csv_dir),
            "filenames": names,
            "formats": sorted({item["format"] for item in self.history.files}),
            "device_spec": (catalog.spec(self.device_type).as_dict()
                            if catalog.spec(self.device_type) else None),
        }

    def close(self) -> None:
        self.status = "closed"


class Monitor:
    """Owns the mode, the connected profiles, the file tabs, and the one thread."""

    def __init__(self, log_root: Path = LOG_ROOT) -> None:
        self.log_root = Path(log_root)
        self.mode = "live"
        self.started_at = time.time()
        self.lock = threading.RLock()
        self._devices: dict[str, Device] = {}
        self._remotes: dict[str, RemoteSource] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- lifecycle -------------------------------------------------------
    @property
    def csv_dir(self) -> Path:
        """The one directory this service reads and writes.  There is no other."""
        return self.log_root / "CSV"

    def start(self) -> None:
        self.csv_dir.mkdir(parents=True, exist_ok=True)
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="monitor", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        with self.lock:
            for remote in list(self._remotes.values()):
                remote.close()
            self._remotes.clear()
            for device in list(self._devices.values()):
                device.close()
            self._devices.clear()

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.time()
            try:
                self._tick(started)
            except Exception:
                log.exception("monitor tick failed")
            # A slow sweep (eight Lake Shore channels at 9600 baud) shortens the
            # wait rather than pushing every later reading late.
            self._stop.wait(max(0.05, POLL_INTERVAL - (time.time() - started)))

    def _tick(self, now: float) -> None:
        with self.lock:
            remotes = list(self._remotes.values())
            devices = list(self._devices.values())

        # One request per remote host, however many gauges are on it.
        for remote in remotes:
            remote.poll(now)
        for device in devices:
            if isinstance(device, RemoteDevice):
                continue  # its source just filled it in
            device.poll(now)
        for device in devices:
            if device.writer is not None:
                device.writer.flush()

    # -- mode ------------------------------------------------------------
    def set_mode(self, mode: str) -> dict:
        mode = (mode or "").strip().lower()
        if mode not in MODES:
            raise ValueError(f"The source is one of {', '.join(MODES)}")
        with self.lock:
            if mode == self.mode:
                return self.config()
            # Switching closes everything: the two sources do not mix.
            for remote in list(self._remotes.values()):
                remote.close()
            self._remotes.clear()
            for device in list(self._devices.values()):
                device.close()
            self._devices.clear()
            self.mode = mode
        self.csv_dir.mkdir(parents=True, exist_ok=True)
        log.info("source is now %s", mode)
        return self.config()

    # -- live: profiles --------------------------------------------------
    def connect_profile(self, profile: dict, continue_history: bool = False) -> list[dict]:
        """Open a saved instrument, or start mirroring a saved remote host.

        `continue_history` reads the profile's earlier logs back in, so the
        chart carries on from where the last run left off rather than starting
        at nothing.
        """
        if self.mode != "live":
            raise ValueError("Switch the source to Live instruments first")

        if profile["kind"] == "remote":
            with self.lock:
                if profile["id"] in self._remotes:
                    raise ValueError(f"{profile['name']} is already connected")
            source = RemoteSource(profile, self.csv_dir)
            source.poll(time.time())
            if source.last_error:
                source.close()
                raise RuntimeError(source.last_error)
            with self.lock:
                self._remotes[profile["id"]] = source
                for device in source.devices.values():
                    self._devices[device.id] = device
            log.info("connected remote %s (%d devices)", profile["url"], len(source.devices))
            return [device.snapshot() for device in source.devices.values()]

        from .portlock import describe

        device_id = _slug(f"{profile['device_type']}-{profile['port']}")
        where = f" on {profile['port']}" if profile["port"] else ""
        with self.lock:
            if device_id in self._devices:
                raise ValueError(f"{profile['device_type']}{where} is already connected")
        # Two readers on one tty is not an error the kernel reports -- they
        # simply split the byte stream and both lose readings.
        conflict = describe(profile["port"])
        if conflict:
            raise ValueError(
                f"{conflict}. Two programs reading one gauge would each get part of the "
                "data and neither would be right. Stop that one first."
            )

        device = SerialDevice(
            profile["device_type"],
            profile["port"],
            profile["name"],
            self.csv_dir,
            history_files=list(profile.get("log_files") or []) if continue_history else None,
        )
        device.profile_id = profile["id"]
        # Remember the file this run is writing, so a later Continue finds it.
        record_log_file(profile["id"], device.writer.path.name)
        with self.lock:
            if device.id in self._devices:
                device.close()  # a second request got there first
                raise ValueError(f"{profile['device_type']}{where} is already connected")
            self._devices[device.id] = device
        log.info("connected %s (%s%s)", device.id, profile["device_type"], where)
        return [device.snapshot()]

    def disconnect_profile(self, profile_id: str) -> None:
        with self.lock:
            remote = self._remotes.pop(profile_id, None)
            if remote is not None:
                for device in remote.devices.values():
                    self._devices.pop(device.id, None)
                remote.close()
                log.info("disconnected remote %s", profile_id)
                return
            for device_id, device in list(self._devices.items()):
                if device.profile_id == profile_id:
                    self._devices.pop(device_id)
                    device.close()
                    log.info("disconnected %s", device_id)
                    return
        raise KeyError(profile_id)

    def connected_profiles(self) -> dict[str, list[str]]:
        """Profile id -> the device ids it is currently providing."""
        out: dict[str, list[str]] = {}
        with self.lock:
            for device in self._devices.values():
                if device.profile_id:
                    out.setdefault(device.profile_id, []).append(device.id)
        return out

    def profile_error(self, profile_id: str) -> str | None:
        with self.lock:
            remote = self._remotes.get(profile_id)
        return remote.last_error if remote else None

    # -- attach: file sets -----------------------------------------------
    def attach_files(self, filenames: list[str], name: str = "") -> dict:
        """Make a tab out of one or more logs, drawn as one continuous trace."""
        if self.mode != "attach":
            raise ValueError("Switch the source to Attach to CSV first")
        if not filenames:
            raise ValueError("Choose at least one file")
        for filename in filenames:
            if not csvlog.is_safe_filename(filename):
                raise ValueError(f"{filename!r} is not a log filename")
        device = FileSetDevice(name, filenames, self.csv_dir)
        with self.lock:
            if device.id in self._devices:
                raise ValueError("Those files are already open in a tab")
            self._devices[device.id] = device
        log.info("attached %s (%d files)", device.id, len(device.files))
        return device.snapshot()

    def remove_device(self, device_id: str) -> None:
        with self.lock:
            device = self._devices.pop(device_id, None)
            if device is not None and device.profile_id:
                self._remotes.pop(device.profile_id, None)
        if device is None:
            raise KeyError(device_id)
        device.close()
        log.info("closed %s", device_id)

    # -- reads -----------------------------------------------------------
    def config(self) -> dict:
        return {
            "mode": self.mode,
            "poll_interval": POLL_INTERVAL,
            "history_limit": HISTORY_LIMIT,
            "csv_dir": str(self.csv_dir),
            "log_root": str(self.log_root),
            "started_at": self.started_at,
            "writes_csv": self.mode == "live",
        }

    def devices(self) -> list[Device]:
        with self.lock:
            return sorted(self._devices.values(), key=lambda device: device.id)

    def get(self, device_id: str) -> Device:
        with self.lock:
            device = self._devices.get(device_id)
        if device is None:
            raise KeyError(device_id)
        return device

    def snapshots(self) -> list[dict]:
        return [device.snapshot() for device in self.devices()]


#: The one monitor the service runs.
monitor = Monitor()
