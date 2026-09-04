import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { errorMessage } from "@/lib/api"
import type { SeriesResponse } from "@/lib/types"
import type { TimeWindow } from "@/components/chart/use-time-range"

/** A window query, as both the device and the log endpoints take one. */
export interface SeriesQuery {
  from?: number | null
  to?: number | null
  maxPoints?: number
  units?: Record<number, string>
  signal?: AbortSignal
}

export interface SeriesState {
  data: SeriesResponse | null
  loading: boolean
  error: string | null
  /** Add a sample that arrived on the status socket, in device units. */
  push: (at: number, values: (number | null)[]) => void
  refresh: () => void
}

/** Wait this long after the last window change before asking the server. */
const DEBOUNCE_MS = 120

/**
 * Fetch this much more than the chart is showing, on each side.
 *
 * Without it a zoom-out is a visible stutter: the axis widens at once, the
 * samples for the wider window have not arrived, and for a moment the trace is
 * squeezed into the middle of an empty chart. Half a window of margin either
 * side means the data for a zoom-out of up to 2x, or a pan of up to half a
 * screen, is already in the browser -- so the common gestures redraw
 * immediately and only the wider ones go back to the server.
 */
const MARGIN = 0.5

/** However live the chart is, re-read the whole window this often. */
const RESYNC_MS = 30_000

/**
 * The samples for one chart window.
 *
 * Two things feed it. The window itself is a query -- pan or zoom and the
 * server answers with the samples inside the new bounds, already decimated, so
 * zooming in reveals detail rather than magnifying pixels. Between those, a
 * live chart is kept current by pushing the readings arriving on the status
 * socket straight onto the end, which costs no request at all.
 *
 * The two are reconciled every half minute by re-reading the window, so a
 * chart left running overnight cannot drift away from the file on disk.
 */
export function useSeries(
  fetcher: (query: SeriesQuery) => Promise<SeriesResponse>,
  window: TimeWindow,
  units: Record<number, string>,
  options: { maxPoints?: number; follow?: boolean; enabled?: boolean } = {},
): SeriesState {
  const { maxPoints = 2000, follow = false, enabled = true } = options

  const [data, setData] = useState<SeriesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the values matter for re-running the fetch, not the object identity.
  const unitKey = useMemo(
    () =>
      Object.entries(units)
        .map(([index, unit]) => `${index}:${unit}`)
        .sort()
        .join(","),
    [units],
  )

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const unitsRef = useRef(units)
  unitsRef.current = units
  // Responses can come back out of order after a fast drag; only the newest
  // request is allowed to set the data.
  const requestRef = useRef(0)

  // Following moves the window every second, and refetching that often would
  // be pointless -- the socket is already delivering those samples. So while
  // following, only a change of width is a new query; the timer below handles
  // keeping it honest.
  // Rounded to three significant figures, not to the second.
  //
  // While following, the right edge is now, so the All preset's width grows by
  // a second every second. Keyed exactly, that is a new query every second --
  // and a query over months takes longer than a second, so every answer
  // arrived after a newer request had already superseded it and was thrown
  // away. The chart stayed empty forever, and only on the one preset whose
  // width is not fixed. Three figures means a re-read when the window has
  // grown by a tenth of a percent; the resync timer keeps it honest between
  // those.
  const bucket = follow
    ? `follow:${(window.to - window.from).toPrecision(3)}`
    : `fixed:${window.from.toFixed(1)}:${window.to.toFixed(1)}`

  /** The window actually asked for: what is shown, plus the margin. */
  const padded = useCallback((from: number, to: number) => {
    const margin = (to - from) * MARGIN
    return { from: from - margin, to: to + margin }
  }, [])

  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (from: number, to: number) => {
      const request = ++requestRef.current
      // Superseded work is cancelled rather than merely ignored: a wide window
      // is seconds of reading on the server, and leaving those to finish for
      // an answer nobody will use is the difference between a chart that keeps
      // up and one that falls behind.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      try {
        const wide = padded(from, to)
        const response = await fetcherRef.current({
          from: wide.from,
          to: wide.to,
          // The margin is data the chart may need but is not showing, so the
          // resolution of what *is* on screen must not pay for it.
          maxPoints: Math.round(maxPoints * (1 + 2 * MARGIN)),
          units: unitsRef.current,
          signal: controller.signal,
        })
        if (request !== requestRef.current) return
        setData(response)
        setError(null)
      } catch (err) {
        // An abort is this hook replacing its own request, not a failure.
        if (request !== requestRef.current || controller.signal.aborted) return
        setError(errorMessage(err))
      } finally {
        if (request === requestRef.current) setLoading(false)
      }
    },
    [maxPoints, padded],
  )

  const windowRef = useRef(window)
  windowRef.current = window

  useEffect(() => {
    if (!enabled) return
    const { from, to } = windowRef.current
    const timer = setTimeout(() => void load(from, to), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `bucket` is the debounced identity of the window; see above.
  }, [bucket, unitKey, enabled, load])

  // A live chart still has to resync on a timer of its own: with no window
  // change and no new bucket, nothing above would fire.
  useEffect(() => {
    if (!enabled || !follow) return
    const timer = setInterval(() => {
      const { from, to } = windowRef.current
      void load(from, to)
    }, RESYNC_MS)
    return () => clearInterval(timer)
  }, [enabled, follow, load])

  const push = useCallback((at: number, values: (number | null)[]) => {
    setData((current) => {
      if (current === null) return current
      let changed = false
      const series = current.series.map((channel) => {
        const raw = values[channel.index]
        if (raw == null || !Number.isFinite(raw)) return channel
        const last = channel.t[channel.t.length - 1]
        if (last !== undefined && at <= last) return channel
        changed = true
        // The socket carries the instrument's own unit; the chart is in
        // whatever the operator picked, so the same conversion the server
        // applied to the window has to apply here too.
        const value = raw * channel.conversion.factor + channel.conversion.offset
        return {
          ...channel,
          t: [...channel.t, at],
          v: [...channel.v, value],
          total: channel.total + 1,
        }
      })
      return changed ? { ...current, series } : current
    })
  }, [])

  const refresh = useCallback(() => {
    const { from, to } = windowRef.current
    void load(from, to)
  }, [load])

  return { data, loading, error, push, refresh }
}
