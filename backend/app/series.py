"""In-memory sample buffers, and the decimation that keeps a chart honest.

The service this replaces sent every buffered sample to every browser on every
poll -- 21 600 points per channel, several times a second. Here the samples
stay on the server and a chart asks for the window it is showing.

Decimation is min/max rather than a plain stride. A pressure burst can be one
sample wide, and a stride will happily step over it; min/max keeps the extreme
of every bucket, so the envelope on screen is the envelope in the data.
"""

from __future__ import annotations

import bisect
import math
import threading

from .config import HISTORY_LIMIT

#: Trim in one slice once the buffer is this far past its cap, rather than
#: shifting the whole list on every append.
_TRIM_SLACK = 4096


class Buffer:
    """Timestamped samples for one channel, oldest first.

    Appends are strictly increasing in time, which is what lets a window query
    be two bisections rather than a scan.
    """

    __slots__ = ("_times", "_values", "_limit", "_lock", "_dropped")

    def __init__(self, limit: int = HISTORY_LIMIT) -> None:
        self._times: list[float] = []
        self._values: list[float] = []
        self._limit = max(1, limit)
        self._lock = threading.Lock()
        #: How many samples have aged out of the buffer, for the UI to report.
        self._dropped = 0

    def append(self, at: float, value: float) -> None:
        if not math.isfinite(at) or not math.isfinite(value):
            return
        with self._lock:
            # Out-of-order arrivals would break the bisect, and mean the clock
            # went backwards. Keep the sample, keep the ordering.
            if self._times and at < self._times[-1]:
                at = self._times[-1]
            self._times.append(at)
            self._values.append(value)
            if len(self._times) > self._limit + _TRIM_SLACK:
                cut = len(self._times) - self._limit
                del self._times[:cut]
                del self._values[:cut]
                self._dropped += cut

    def clear(self) -> None:
        with self._lock:
            self._times.clear()
            self._values.clear()
            self._dropped = 0

    def __len__(self) -> int:
        return len(self._times)

    @property
    def latest(self) -> tuple[float, float] | None:
        with self._lock:
            if not self._times:
                return None
            return self._times[-1], self._values[-1]

    @property
    def span(self) -> tuple[float, float] | None:
        """(first, last) timestamps held, or None when empty."""
        with self._lock:
            if not self._times:
                return None
            return self._times[0], self._times[-1]

    @property
    def dropped(self) -> int:
        return self._dropped

    def window(self, start: float | None, end: float | None) -> tuple[list[float], list[float]]:
        """Copy of the samples in [start, end], both bounds optional."""
        with self._lock:
            lo = 0 if start is None else bisect.bisect_left(self._times, start)
            hi = len(self._times) if end is None else bisect.bisect_right(self._times, end)
            return self._times[lo:hi], self._values[lo:hi]


def decimate(
    times: list[float], values: list[float], max_points: int
) -> tuple[list[float], list[float], bool]:
    """Reduce to at most ``max_points`` samples, keeping every extreme.

    Each bucket contributes its minimum and its maximum, emitted in the order
    they occurred so the line still runs left to right. Returns the samples and
    whether anything was actually dropped.
    """
    count = len(times)
    if max_points < 4 or count <= max_points:
        return times, values, False

    buckets = max_points // 2
    out_t: list[float] = []
    out_v: list[float] = []
    for index in range(buckets):
        lo = count * index // buckets
        hi = count * (index + 1) // buckets
        if lo >= hi:
            continue
        lo_i = hi_i = lo
        low = high = values[lo]
        for j in range(lo + 1, hi):
            v = values[j]
            if v < low:
                low, lo_i = v, j
            elif v > high:
                high, hi_i = v, j
        first, second = (lo_i, hi_i) if lo_i <= hi_i else (hi_i, lo_i)
        out_t.append(times[first])
        out_v.append(values[first])
        if second != first:
            out_t.append(times[second])
            out_v.append(values[second])

    # The ends are always kept. A bucket contributes its extremes, and the very
    # first sample is usually not one of them -- so without this the line
    # starts somewhere inside the window rather than at its beginning, and a
    # chart of everything appears to begin weeks after the record does.
    if out_t and out_t[0] != times[0]:
        out_t.insert(0, times[0])
        out_v.insert(0, values[0])
    if out_t and out_t[-1] != times[-1]:
        out_t.append(times[-1])
        out_v.append(values[-1])
    return out_t, out_v, True
