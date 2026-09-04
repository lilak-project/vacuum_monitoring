"""Small helpers for the hand-edited JSON files this service persists to."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def read_dict(path: Path) -> dict:
    """Return ``path`` parsed as a dict, or ``{}`` if missing or unreadable."""
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_dict(path: Path, data: dict) -> None:
    """Write ``data`` atomically so a crash can't leave a truncated file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
