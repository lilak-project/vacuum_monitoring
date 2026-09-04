"""Request and response models for the HTTP + WebSocket API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Mode = Literal["live", "attach"]
Kind = Literal["serial", "remote"]


class SourceRequest(BaseModel):
    """Live instruments, or logs read back off disk.  The two do not mix."""

    mode: Mode


class ProfileRequest(BaseModel):
    """Something to connect to: an instrument on a port, or another host."""

    kind: Kind = "serial"
    name: str = ""
    #: serial only
    device_type: str = ""
    port: str = ""
    #: remote only
    url: str = ""
    autostart: bool = True
    #: How the chart is read.  "" means the unit the instrument reports.
    display_unit: str = ""
    #: None means "decide from what is being measured" -- log for pressure.
    log_y: bool | None = None
    #: Where the big grey reading sits: "center", or one quarter of the plot.
    watermark_at: str = "center"


class Profile(ProfileRequest):
    id: str
    #: Logs this profile has written, oldest first.  Continue reads them back.
    log_files: list[str] = []
    #: Filled in from the running monitor, not from the file.
    connected: bool = False
    device_ids: list[str] = []
    last_error: str | None = None
    #: True while the connected run is stitched onto the earlier logs.
    continued: bool = False


class ViewRequest(BaseModel):
    """How a profile's chart is read.  Either field may be left out."""

    display_unit: str | None = None
    log_y: bool | None = None
    watermark_at: str | None = None


class HistoryRequest(BaseModel):
    """The logs a profile counts as its own past."""

    filenames: list[str] = []


class AttachRequest(BaseModel):
    """Logs to open as one tab, drawn as one continuous trace."""

    filenames: list[str] = Field(min_length=1)
    name: str = ""


class ChannelReading(BaseModel):
    index: int
    label: str
    unit: str
    value: float | None
    at: float | None
    points: int
    recorded: int
    dropped: int
    first_at: float | None
    last_at: float | None


class DeviceSnapshot(BaseModel):
    """Metadata and the current reading.  History is fetched per chart window."""

    id: str
    name: str
    device_type: str
    measure: str
    source: str
    profile_id: str | None
    status: str
    last_error: str | None
    opened_at: float | None
    channels: list[ChannelReading]
    log_path: str | None
    log_rows: int
    polls: int
    poll_errors: int
    last_poll_at: float | None
    last_poll_ms: float | None


class SeriesChannel(BaseModel):
    index: int
    label: str
    unit: str
    device_unit: str
    conversion: dict
    #: Timestamps and values as parallel arrays: what the chart consumes, and
    #: about half the bytes of a list of pairs.
    t: list[float]
    v: list[float]
    total: int
    decimated: bool


class SeriesResponse(BaseModel):
    id: str
    name: str
    measure: str
    source: str
    start: float | None
    end: float | None
    max_points: int
    series: list[SeriesChannel]
