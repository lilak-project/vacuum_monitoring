"""Who else has a serial port open.

Linux will happily let two processes open the same tty. Nothing stops it and
nothing warns about it -- both then read from the same stream and each gets
whichever bytes the other did not, which for a gauge that free-runs a checksummed
frame means both sides silently lose most of their readings.

That is a live hazard here: the service this replaces holds `/dev/ttyUSB0`, and
starting this one on the same port without noticing would quietly degrade the
monitoring that is already running. So the port is checked before it is opened,
and the answer is shown in the Sources tab beside the port rather than only
appearing as a refusal after the fact.

The check reads `/proc/<pid>/fd`, so it sees other processes of the same user
(which is what these all are) and is quiet about the rest.
"""

from __future__ import annotations

import os
from pathlib import Path

_PROC = Path("/proc")


def _command(pid: str) -> str:
    try:
        raw = (_PROC / pid / "cmdline").read_bytes()
    except OSError:
        return ""
    return " ".join(part for part in raw.decode("utf-8", "replace").split("\0") if part)


#: Naming the interpreter tells nobody anything; the script it is running does.
_INTERPRETERS = ("python", "python3", "sh", "bash", "node", "perl", "ruby")


def short_name(command: str) -> str:
    """"cmms_web.py" out of "python3 cmms_web.py --host 0.0.0.0 --port 8000"."""
    parts = command.split()
    if not parts:
        return "a process"
    first = os.path.basename(parts[0])
    if any(first.startswith(name) for name in _INTERPRETERS):
        for part in parts[1:]:
            if not part.startswith("-"):
                return os.path.basename(part)
    return first


def holders(port: str, exclude_self: bool = True) -> list[dict]:
    """Every process holding `port` open, as {pid, command}.

    Returns an empty list when the port is free, when it does not exist, or on
    any platform without /proc -- a check that cannot run must not become a
    refusal to open a port that is in fact available.
    """
    if not port or not _PROC.is_dir():
        return []
    try:
        target = os.path.realpath(port)
    except OSError:
        return []

    mine = str(os.getpid())
    found: list[dict] = []
    for entry in _PROC.iterdir():
        if not entry.name.isdigit() or (exclude_self and entry.name == mine):
            continue
        fd_dir = entry / "fd"
        try:
            handles = list(fd_dir.iterdir())
        except OSError:
            continue  # another user's process, or it exited mid-scan
        for handle in handles:
            try:
                if os.path.realpath(handle) == target:
                    command = _command(entry.name)
                    found.append(
                        {
                            "pid": int(entry.name),
                            "command": command,
                            "name": short_name(command),
                        }
                    )
                    break
            except OSError:
                continue
    return found


def describe(port: str) -> str:
    """A sentence naming what already has the port, or "" when it is free."""
    found = holders(port)
    if not found:
        return ""
    who = ", ".join(f"{short_name(item['command'])} (pid {item['pid']})" for item in found)
    return f"{port} is already open by {who}"
