import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { RANGE_PRESETS } from "@/lib/time"

/** The window a chart is showing, in unix seconds. */
export interface TimeWindow {
  from: number
  to: number
}

/** Shortest window any control will produce. */
const MIN_SPAN = 10

/**
 * The x axis as a small state machine.
 *
 * There are only two things to know: how wide the window is, and whether its
 * right edge is pinned to now. Every control -- the presets, the pan and zoom
 * buttons, a drag on the chart, the from/to boxes -- is one of those two
 * changing, and "follow live" is simply the right edge being now rather than a
 * fixed instant. Holding it this way is what keeps zooming into a live chart
 * from fighting with the chart scrolling out from under you: the moment you
 * choose an end, following stops.
 */
export interface TimeRangeControl {
  window: TimeWindow
  /** Preset id, or "custom" once a gesture or a typed bound has moved it. */
  presetId: string
  /** True while the right edge is pinned to now. */
  follow: boolean
  span: number
  choosePreset: (id: string) => void
  /** From a drag, a wheel, or a pan: an explicit window, following off. */
  setWindow: (from: number, to: number) => void
  /** Shift by a fraction of the current width; negative goes back in time. */
  pan: (fraction: number) => void
  /** >1 widens the window, <1 narrows it, about its centre. */
  zoom: (factor: number) => void
  setFollow: (on: boolean) => void
  /** Back to the last preset, following again. */
  reset: () => void
  /** The window is already against the oldest / newest sample there is. */
  atStart: boolean
  atEnd: boolean
}

const DEFAULT_PRESET = "10m"
const presetSpan = (id: string) => RANGE_PRESETS.find((preset) => preset.id === id)?.seconds ?? null

export function useTimeRange(
  /** Timestamp of the oldest sample there is, for the All preset. */
  dataStart: number | null,
  /** Newest sample, or null for something still being read (i.e. "now"). */
  dataEnd: number | null = null,
): TimeRangeControl {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET)
  const [span, setSpan] = useState<number>(presetSpan(DEFAULT_PRESET) ?? 600)
  /** null means "now": the window follows the clock. */
  const [end, setEnd] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now() / 1000)

  const follow = end === null

  // While following, the window has to advance on its own -- a live chart
  // whose right edge is yesterday is not a live chart. One tick a second, the
  // same rate the instruments are read at.
  useEffect(() => {
    if (!follow) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [follow])

  // "All" is only meaningful once we know how far back the samples go.
  const allSpan = dataStart != null ? Math.max(MIN_SPAN, now - dataStart) : null
  const effectiveSpan = presetId === "all" && follow ? (allSpan ?? span) : span
  const right = end ?? now

  const window = useMemo<TimeWindow>(() => {
    const to = right
    const from = to - effectiveSpan
    // The same clamp the gestures use, so a preset wider than the data does
    // not open onto empty axis either.
    const min = dataStart
    const max = dataEnd ?? now
    if (min == null) return { from, to }
    if (effectiveSpan >= max - min) return { from: min, to: max }
    if (from < min) return { from: min, to: min + effectiveSpan }
    if (to > max) return { from: max - effectiveSpan, to: max }
    return { from, to }
  }, [right, effectiveSpan, dataStart, dataEnd, now])

  // Gestures read the live window without re-subscribing to it.
  const windowRef = useRef(window)
  windowRef.current = window

  const choosePreset = useCallback((id: string) => {
    setPresetId(id)
    setEnd(null)
    const seconds = presetSpan(id)
    if (seconds != null) setSpan(seconds)
  }, [])

  // Where the samples actually are. Panning past either end would scroll into
  // blank space, which reads as "the gauge stopped" rather than "there is
  // nothing here", so every gesture is clamped to it.
  const boundsRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null })
  boundsRef.current = { min: dataStart, max: dataEnd }

  /** Slide a window back inside the data, keeping its width. */
  const clamp = useCallback((from: number, to: number): [number, number] => {
    const width = Math.max(MIN_SPAN, to - from)
    const { min } = boundsRef.current
    const max = boundsRef.current.max ?? Date.now() / 1000
    if (min == null) return [to - width, to]
    // A window wider than everything there is shows everything there is.
    if (width >= max - min) return [min, max]
    if (from < min) return [min, min + width]
    if (to > max) return [max - width, max]
    return [from, to]
  }, [])

  const setWindow = useCallback(
    (rawFrom: number, rawTo: number) => {
      const [from, to] = clamp(rawFrom, rawTo)
      setSpan(Math.max(MIN_SPAN, to - from))
      setPresetId("custom")
      // Reaching the live end is a request to follow again -- otherwise the
      // chart freezes the instant you look at the present.
      const now = Date.now() / 1000
      setEnd(boundsRef.current.max == null && to >= now - 1 ? null : to)
    },
    [clamp],
  )

  const pan = useCallback((fraction: number) => {
    const { from, to } = windowRef.current
    const shift = (to - from) * fraction
    setWindow(from + shift, to + shift)
  }, [setWindow])

  const zoom = useCallback(
    (factor: number) => {
      const { from, to } = windowRef.current
      const width = Math.max(MIN_SPAN, (to - from) * factor)
      if (end === null) {
        // Zooming a live chart keeps the present on screen; it is what you
        // are watching. Only the amount of history behind it changes.
        setSpan(width)
        setPresetId("custom")
        return
      }
      const centre = (from + to) / 2
      setWindow(centre - width / 2, centre + width / 2)
    },
    [end, setWindow],
  )

  /** True at either end, so the pan buttons can grey themselves out. */
  const atStart = dataStart != null && window.from <= dataStart + 0.5
  const atEnd = window.to >= (dataEnd ?? now) - 0.5

  const setFollow = useCallback((on: boolean) => {
    setEnd(on ? null : Date.now() / 1000)
  }, [])

  const reset = useCallback(() => {
    choosePreset(presetId === "custom" ? DEFAULT_PRESET : presetId)
  }, [choosePreset, presetId])

  return {
    window,
    presetId,
    follow,
    span: effectiveSpan,
    choosePreset,
    setWindow,
    pan,
    zoom,
    setFollow,
    reset,
    atStart,
    atEnd,
  }
}
