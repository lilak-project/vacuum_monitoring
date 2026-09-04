"""Saved profiles: everything this service knows how to connect to.

A profile is one of two things, and the UI shows them in one list because from
the operator's side they are the same act -- something with a name, that you
press Connect on:

- **serial** — an instrument on a port of this machine, which this service
  opens and reads itself.
- **remote** — another host running this service. Connecting mirrors its
  devices, and their readings are written to this machine's own log directory
  like any other.

Deleting a profile records nothing; it is simply gone. Connecting is separate
from being saved, so a profile can sit in the list unconnected -- which is the
point of the list.
"""

from __future__ import annotations

import re
import threading

from ..config import PROFILE_FILE
from ._jsonfile import read_dict, write_dict

_lock = threading.Lock()

KINDS = ("serial", "remote")

#: Where the reading can be written behind the trace: filling the plot, or in
#: one quarter of it, out of the way of wherever the line happens to be.
WATERMARK_POSITIONS = ("center", "top-left", "top-right", "bottom-left", "bottom-right")


def slug(text: str) -> str:
    """A stable, URL-safe id for a profile."""
    out = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return out or "profile"


def profile_id(entry: dict) -> str:
    """Identity of a profile: one instrument per port, one service per URL."""
    if entry["kind"] == "remote":
        return slug(f"remote-{entry['url']}")
    return slug(f"{entry['device_type']}-{entry['port']}")


def normalize(entry: dict) -> dict:
    """Validate and canonicalise one profile.  Raises ValueError if it cannot."""
    kind = str(entry.get("kind", "serial")).strip().lower()
    if kind not in KINDS:
        raise ValueError(f"A profile is either {' or '.join(KINDS)}")

    if kind == "remote":
        url = str(entry.get("url", "")).strip()
        if not url:
            raise ValueError("A remote profile needs the other host's address")
        if not url.startswith(("http://", "https://")):
            url = "http://" + url
        url = url.rstrip("/")
        normalized = {
            "kind": "remote",
            "url": url,
            "name": str(entry.get("name", "")).strip() or url.split("//", 1)[-1],
            "device_type": "",
            "port": "",
        }
    else:
        device_type = str(entry.get("device_type", "")).strip()
        if not device_type:
            raise ValueError("An instrument profile needs a device type")
        normalized = {
            "kind": "serial",
            "url": "",
            "device_type": device_type,
            "port": str(entry.get("port", "")).strip(),
            "name": str(entry.get("name", "")).strip() or device_type,
        }

    normalized["autostart"] = bool(entry.get("autostart", True))
    # How this profile's chart is read. Kept with the profile rather than in
    # the browser: the unit a gauge is watched in is a property of the gauge
    # and the person watching it, not of the tab that happens to be open, and
    # it should survive a tab switch, a reload, and another machine.
    normalized["display_unit"] = str(entry.get("display_unit", "") or "").strip()
    log_y = entry.get("log_y")
    normalized["log_y"] = None if log_y is None else bool(log_y)
    # Which part of the plot the big grey reading sits in.
    corner = str(entry.get("watermark_at", "") or "center").strip().lower()
    normalized["watermark_at"] = corner if corner in WATERMARK_POSITIONS else "center"
    # Every log this profile has ever written, oldest first. Connecting with
    # Continue reads them back so the chart carries on from where the last run
    # left off instead of starting at zero.
    files = entry.get("log_files")
    normalized["log_files"] = [str(item) for item in files if str(item)] if isinstance(files, list) else []
    normalized["id"] = profile_id(normalized)
    return normalized


def load_profiles() -> list[dict]:
    data = read_dict(PROFILE_FILE)
    saved = data.get("profiles")
    saved = saved if isinstance(saved, list) else []
    out: list[dict] = []
    seen: set[str] = set()
    for entry in saved:
        if not isinstance(entry, dict):
            continue
        try:
            normalized = normalize(entry)
        except ValueError:
            continue
        if normalized["id"] in seen:
            continue
        out.append(normalized)
        seen.add(normalized["id"])
    return out


def get_profile(profile_id_: str) -> dict | None:
    return next((item for item in load_profiles() if item["id"] == profile_id_), None)


def save_profile(entry: dict) -> list[dict]:
    normalized = normalize(entry)
    with _lock:
        existing = next((item for item in load_profiles() if item["id"] == normalized["id"]), None)
        # An edit from the UI does not carry the log history, and must not
        # silently throw it away.
        if existing and not normalized["log_files"]:
            normalized["log_files"] = existing["log_files"]
        profiles = [item for item in load_profiles() if item["id"] != normalized["id"]]
        profiles.append(normalized)
        write_dict(PROFILE_FILE, {"profiles": profiles})
    return load_profiles()


def save_view(
    profile_id_: str,
    display_unit: str | None,
    log_y: bool | None,
    watermark_at: str | None = None,
) -> list[dict]:
    """Remember how this profile's chart is being read."""
    with _lock:
        profiles = load_profiles()
        for profile in profiles:
            if profile["id"] != profile_id_:
                continue
            if display_unit is not None:
                profile["display_unit"] = display_unit
            if log_y is not None:
                profile["log_y"] = log_y
            if watermark_at in WATERMARK_POSITIONS:
                profile["watermark_at"] = watermark_at
            write_dict(PROFILE_FILE, {"profiles": profiles})
            break
    return load_profiles()


def record_log_file(profile_id_: str, filename: str) -> None:
    """Remember that this profile wrote `filename`, for a later Continue."""
    if not profile_id_ or not filename:
        return
    with _lock:
        profiles = load_profiles()
        for profile in profiles:
            if profile["id"] != profile_id_:
                continue
            if filename in profile["log_files"]:
                return
            profile["log_files"].append(filename)
            write_dict(PROFILE_FILE, {"profiles": profiles})
            return


def set_log_files(profile_id_: str, filenames: list[str]) -> list[dict]:
    """Replace the logs this profile counts as its own history.

    Used to adopt runs it did not write: the same gauge on the same chamber was
    logged by an earlier program, and those files are the beginning of the same
    line. Which files belong together is the operator's judgement, not
    something this service can work out from a filename.
    """
    with _lock:
        profiles = load_profiles()
        for profile in profiles:
            if profile["id"] == profile_id_:
                # Order is by name, which for both naming schemes is order by
                # time; the reader sorts by first sample anyway.
                profile["log_files"] = sorted({str(item) for item in filenames if str(item)})
                write_dict(PROFILE_FILE, {"profiles": profiles})
                break
    return load_profiles()


def forget_log_files(profile_id_: str) -> list[dict]:
    """Drop the remembered history, so the next connect starts clean."""
    with _lock:
        profiles = load_profiles()
        for profile in profiles:
            if profile["id"] == profile_id_:
                profile["log_files"] = []
        write_dict(PROFILE_FILE, {"profiles": profiles})
    return load_profiles()


def delete_profile(profile_id_: str) -> list[dict]:
    with _lock:
        profiles = [item for item in load_profiles() if item["id"] != profile_id_]
        write_dict(PROFILE_FILE, {"profiles": profiles})
    return load_profiles()
