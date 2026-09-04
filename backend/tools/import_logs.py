#!/usr/bin/env python3
"""Bring measurement logs from earlier installs into this service's log directory.

The BCG450's history is spread across five directories, left behind as the
logging moved between installs: `pressure-bcg450/cmms-web`, its
`cmms-soom-linux` predecessor, the saved runs under `cmms/pressure_saved`, and
copies in `ai_service` and `shift_service`. Together they are about three
months of pressure, and none of it was reachable from one place.

This copies them in. It does not move them and it does not rewrite them --
the originals stay exactly where they are and byte-for-byte as they were, and
the copies keep the header they were written with, which this service reads.
What changes is the name: a file becomes `<device>_<when its first sample was
taken>.csv`, so the directory sorts into chronological order and a filename
says which run it is rather than which slot of which session wrote it.

Where each file came from is recorded in `.imported.json` beside them, and
shown in the Logs tab -- a log that arrived from another machine's install
should say so rather than looking native.

    python3 tools/import_logs.py --dry-run     # say what would happen
    python3 tools/import_logs.py               # do it
    python3 tools/import_logs.py DIR [DIR...]  # from somewhere else
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import csvlog  # noqa: E402
from app.config import LOG_ROOT  # noqa: E402

#: Everywhere on this machine a BCG450 log has been written.
DEFAULT_SOURCES = [
    "/home/cens-alpha-00/pressure-bcg450/cmms-web/log/CSV",
    "/home/cens-alpha-00/pressure-bcg450/cmms-soom-linux/log/CSV",
    "/home/cens-alpha-00/pressure-bcg450/cmms/pressure_saved",
    "/home/cens-alpha-00/ai_service/cmms-web/log/CSV",
    "/home/cens-alpha-00/shift_service/cmms-web/log/CSV",
]

MANIFEST = ".imported.json"


def load_manifest(csv_dir: Path) -> dict:
    path = csv_dir / MANIFEST
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_manifest(csv_dir: Path, manifest: dict) -> None:
    (csv_dir / MANIFEST).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def target_name(source: Path, first_at: float) -> str:
    """`BCG450_20260811_174300.csv` -- the device, and when the run started."""
    device = csvlog.safe_name(csvlog.display_name(source.name)) or "log"
    stamp = dt.datetime.fromtimestamp(first_at).strftime("%Y%m%d_%H%M%S")
    return f"{device}_{stamp}.csv"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("sources", nargs="*", default=None, help="directories to import from")
    parser.add_argument("--dest", default=str(LOG_ROOT / "CSV"), help="where to copy them")
    parser.add_argument("--dry-run", action="store_true", help="say what would happen")
    parser.add_argument(
        "--all-formats",
        action="store_true",
        help="also copy files whose header is not a measurement log",
    )
    args = parser.parse_args()

    sources = [Path(item) for item in (args.sources or DEFAULT_SOURCES)]
    dest = Path(args.dest)
    manifest = load_manifest(dest) if dest.is_dir() else {}
    # A file already imported is recognised by where it came from, so running
    # this twice is harmless. It is keyed on the size it had when it was
    # copied, though, because the log the old service is writing right now
    # will have grown since -- re-running after the cutover picks up the rows
    # that were written in between rather than leaving a gap.
    already = {entry["source"]: entry for entry in manifest.values()}

    copied = skipped = empty = foreign = 0
    total_bytes = 0
    spans: list[tuple[float, float]] = []

    for root in sources:
        if not root.is_dir():
            print(f"  ── {root}  (not found)")
            continue
        files = sorted(root.rglob("*.csv"))
        print(f"\n── {root}  ({len(files)} files)")

        for source in files:
            try:
                meta = csvlog.scan_meta(source)
            except OSError as err:
                print(f"   !  {source.name}: {err}")
                continue

            if meta["first_at"] is None or meta["last_at"] is None:
                empty += 1
                print(f"   ·  {source.name[:52]:54} nothing in it")
                continue
            if meta["format"] == "unknown" and not args.all_formats:
                foreign += 1
                print(f"   ·  {source.name[:52]:54} not a measurement log ({meta['header'][:4]}…)")
                continue
            previous = already.get(str(source))
            if previous is not None and previous.get("size") == meta["size"]:
                skipped += 1
                print(f"   =  {source.name[:52]:54} already imported, unchanged")
                continue

            name = target_name(source, meta["first_at"])
            destination = dest / name
            if previous is None:
                # Two runs of one device cannot start in the same second, but a
                # re-import after a rename could still collide.
                suffix = 1
                while destination.exists():
                    suffix += 1
                    destination = dest / name.replace(".csv", f"_{suffix}.csv")
            else:
                # Grown since last time: the same destination is rewritten, so
                # the directory does not accumulate half-copies of one run.
                destination = dest / next(
                    (k for k, v in manifest.items() if v["source"] == str(source)), name
                )
                grew = (meta["size"] - previous["size"]) / 1048576
                print(f"   ↻  {source.name[:40]:42} grew {grew:+.2f} MB since it was imported")

            span = (meta["last_at"] - meta["first_at"]) / 3600
            start = dt.datetime.fromtimestamp(meta["first_at"])
            print(
                f"   →  {source.name[:40]:42} {meta['size'] / 1048576:7.2f} MB  "
                f"{start:%Y-%m-%d %H:%M}  {span:6.1f} h  ->  {destination.name}"
            )

            if not args.dry_run:
                dest.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                manifest[destination.name] = {
                    "source": str(source),
                    "imported_at": dt.datetime.now().isoformat(timespec="seconds"),
                    "format": meta["format"],
                    "first_at": meta["first_at"],
                    "last_at": meta["last_at"],
                    "size": meta["size"],
                }
            copied += 1
            total_bytes += meta["size"]
            spans.append((meta["first_at"], meta["last_at"]))

    if not args.dry_run and copied:
        save_manifest(dest, manifest)

    print("\n" + "─" * 70)
    verb = "would copy" if args.dry_run else "copied"
    print(f"  {verb} {copied} file(s), {total_bytes / 1048576:.1f} MB into {dest}")
    if spans:
        print(
            f"  covering {dt.datetime.fromtimestamp(min(s[0] for s in spans)):%Y-%m-%d} "
            f"to {dt.datetime.fromtimestamp(max(s[1] for s in spans)):%Y-%m-%d}, "
            f"{sum(b - a for a, b in spans) / 86400:.1f} days of readings"
        )
    if skipped:
        print(f"  {skipped} already imported and unchanged")
    if empty:
        print(f"  {empty} skipped: no readings in them")
    if foreign:
        print(f"  {foreign} skipped: not a measurement log (--all-formats to take them anyway)")
    if args.dry_run:
        print("\n  Nothing was written. Run without --dry-run to do it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
