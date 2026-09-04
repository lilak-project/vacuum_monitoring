"""Profiles: the one list of everything this service can connect to.

An instrument on a port and another host's service are different things to the
program and the same thing to the operator -- something with a name that you
press Connect on -- so they share a list, and the live connection state is
merged in rather than kept on a separate screen.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..monitor import monitor
from .. import csvlog
from ..schemas import DeviceSnapshot, HistoryRequest, Profile, ProfileRequest, ViewRequest
from ..store import (
    delete_profile,
    forget_log_files,
    get_profile,
    load_profiles,
    save_profile,
    save_view,
    set_log_files,
)
from ._helpers import run_io

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


def _with_state(profiles: list[dict]) -> list[dict]:
    connected = monitor.connected_profiles()
    out = []
    for profile in profiles:
        ids = connected.get(profile["id"], [])
        continued = False
        for device_id in ids:
            try:
                continued = continued or bool(getattr(monitor.get(device_id), "continued", False))
            except KeyError:
                pass
        out.append(
            {
                **profile,
                "connected": profile["id"] in connected,
                "device_ids": ids,
                "last_error": monitor.profile_error(profile["id"]),
                "continued": continued,
            }
        )
    return out


@router.get("", response_model=list[Profile])
async def list_all() -> list[dict]:
    """Every saved profile, with whether it is connected right now."""
    return _with_state(await run_io(load_profiles))


@router.put("", response_model=list[Profile])
async def upsert(profile: ProfileRequest) -> list[dict]:
    """Add or update a profile.  Saving does not connect it."""
    try:
        return _with_state(await run_io(save_profile, profile.model_dump()))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.delete("/{profile_id}", response_model=list[Profile])
async def remove(profile_id: str) -> list[dict]:
    """Forget a profile.  A connected one is disconnected first."""
    if profile_id in monitor.connected_profiles():
        await run_io(monitor.disconnect_profile, profile_id)
    return _with_state(await run_io(delete_profile, profile_id))


@router.post("/{profile_id}/connect", response_model=list[DeviceSnapshot])
async def connect(
    profile_id: str,
    continue_history: bool = Query(
        False,
        alias="continue",
        description="Read this profile's earlier logs back in, so the chart carries on",
    ),
) -> list[dict]:
    """Open the instrument, or start mirroring the host.  Returns its devices."""
    profile = await run_io(get_profile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"No profile {profile_id!r}")
    try:
        return await run_io(monitor.connect_profile, profile, continue_history)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"{type(err).__name__}: {err}") from err


@router.put("/{profile_id}/view", response_model=list[Profile])
async def set_view(profile_id: str, view: ViewRequest) -> list[dict]:
    """Remember the unit and axis this profile is being read in."""
    return _with_state(
        await run_io(save_view, profile_id, view.display_unit, view.log_y, view.watermark_at)
    )


@router.put("/{profile_id}/history", response_model=list[Profile])
async def set_history(profile_id: str, request: HistoryRequest) -> list[dict]:
    """Choose which logs this profile continues from.

    Reconnect for it to take effect: the stitching is decided when the device
    is opened, not on every query.
    """
    for filename in request.filenames:
        if not csvlog.is_safe_filename(filename):
            raise HTTPException(status_code=400, detail=f"{filename!r} is not a log filename")
        if not (monitor.csv_dir / filename).is_file():
            raise HTTPException(status_code=404, detail=f"No log named {filename}")
    return _with_state(await run_io(set_log_files, profile_id, request.filenames))


@router.post("/{profile_id}/forget-history", response_model=list[Profile])
async def forget_history(profile_id: str) -> list[dict]:
    """Drop the remembered logs, so the next Continue has nothing to continue.

    The files themselves stay where they are; only the profile's memory of
    them goes.
    """
    return _with_state(await run_io(forget_log_files, profile_id))


@router.post("/{profile_id}/disconnect", status_code=204)
async def disconnect(profile_id: str) -> None:
    """Close it.  The CSV it was writing is closed too and stays where it is."""
    try:
        await run_io(monitor.disconnect_profile, profile_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"{profile_id!r} is not connected") from None
