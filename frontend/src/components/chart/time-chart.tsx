import { useEffect, useMemo, useRef } from "react"
import type uPlot from "uplot"

import { formatTick, unitLabel } from "@/lib/format"
import { useTheme } from "@neon"
import { axisColor, chartFont, gridColor, seriesColor, surfaceColor, tickColor } from "@/lib/palette"
import { formatClock } from "@/lib/time"
import type { SeriesChannel } from "@/lib/types"

import { toAligned } from "./chart-data"
import type { TimeWindow } from "./use-time-range"
import { UplotChart } from "./uplot-react"
import { watermarkPlugin, type WatermarkAt } from "./watermark-plugin"
import { zoomPlugin } from "./zoom-plugin"


/** How a time tick is written depends on how much of the axis it has to place.
 *
 *  Every formatter here takes null, for the same reason `formatTick` does: an
 *  axis may hand back a hidden tick as null, and throwing inside uPlot's draw
 *  takes the chart with it. */
function timeTicks(span: number) {
  const blank = (value: number | null | undefined): value is null =>
    value == null || !Number.isFinite(value)

  if (span <= 300) return (value: number | null) => (blank(value) ? "" : formatClock(value, true))
  if (span <= 3 * 3600) return (value: number | null) => (blank(value) ? "" : formatClock(value, false))
  if (span <= 3 * 86400) {
    return (value: number | null) => {
      if (blank(value)) return ""
      const date = new Date(value * 1000)
      const midnight = date.getHours() === 0 && date.getMinutes() === 0
      // A day boundary is the one tick worth naming: it says which night the
      // dip on the left belongs to.
      return midnight
        ? `${date.getMonth() + 1}/${date.getDate()}`
        : formatClock(value, false)
    }
  }
  return (value: number | null) => {
    if (blank(value)) return ""
    const date = new Date(value * 1000)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
}

export function TimeChart({
  channels,
  window,
  logY,
  yRange,
  height = 340,
  loading = false,
  onRange,
  onReset,
  onPlot,
  watermark,
  watermarkAt = "center",
}: {
  channels: SeriesChannel[]
  window: TimeWindow
  logY: boolean
  /** Manual y bounds; auto-scaled when null. */
  yRange: [number, number] | null
  height?: number
  loading?: boolean
  onRange: (from: number, to: number) => void
  onReset: () => void
  /** Handed the plot once it exists, so the card can export its canvas. */
  onPlot?: (plot: uPlot) => void
  /** The current reading, written large and grey behind the trace. */
  watermark?: string
  /** Which part of the plot it sits in. */
  watermarkAt?: WatermarkAt
}) {
  const plotRef = useRef<uPlot | null>(null)
  // Read by the watermark on every draw. A ref, not a dependency: the reading
  // changes once a second and rebuilding the plot for it would throw away the
  // cursor, the selection, and any zoom just made.
  const watermarkRef = useRef(watermark ?? "")
  watermarkRef.current = watermark ?? ""
  const watermarkAtRef = useRef<WatermarkAt>(watermarkAt)
  watermarkAtRef.current = watermarkAt
  const windowRef = useRef(window)
  windowRef.current = window
  const spanRef = useRef(window.to - window.from)
  spanRef.current = window.to - window.from

  const data = useMemo(() => toAligned(channels, { logY }), [channels, logY])

  const unit = channels[0]?.unit ?? ""
  // Canvas colours are read when the chart is built, so a theme change rebuilds it.
  const theme = useTheme()
  // Everything uPlot cannot be told after it is built.
  const rebuildKey = useMemo(
    () =>
      [
        logY ? "log" : "linear",
        yRange ? `${yRange[0]}:${yRange[1]}` : "auto",
        channels.map((channel) => `${channel.index}/${channel.label}/${channel.unit}`).join("|"),
        theme,
      ].join("~"),
    [logY, yRange, channels, theme],
  )

  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(() => {
    return {
      // The clock is the reader's own: a chart of last night's pumpdown is
      // read against the hours they were in the building.
      tzDate: undefined,
      cursor: {
        // uPlot draws the selection; the zoom plugin decides what it means, so
        // a drag can go back to the server for the samples inside it.
        drag: { x: true, y: false, setScale: false },
        points: { size: 8 },
      },
      // Live values at the crosshair, for every channel at once. It is the
      // legend and the tooltip in one: the reader never has to land on a line.
      legend: { live: true, markers: { width: 3 } },
      scales: {
        x: { time: true, auto: false },
        y: {
          // Vacuum spans ten decades; on a linear axis everything below the
          // rough vacuum is a flat line on the floor.
          distr: logY ? 3 : 1,
          log: 10,
          auto: yRange === null,
          ...(yRange ? { range: yRange } : {}),
        },
      },
      axes: [
        {
          stroke: axisColor(),
          font: chartFont(),
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map(timeTicks(spanRef.current)),
        },
        {
          scale: "y",
          label: unitLabel(unit),
          labelFont: chartFont(),
          stroke: axisColor(),
          font: chartFont(),
          size: 68,
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map(formatTick),
        },
      ],
      series: [
        { label: "Time", value: (_self: uPlot, value: number | null) =>
            value == null || !Number.isFinite(value) ? "—" : formatClock(value, true) },
        ...channels.map((channel, position) => ({
          label: channel.label,
          scale: "y",
          stroke: seriesColor(channel.index >= 0 ? channel.index : position),
          width: 2,
          // Drawn through the nulls a log axis leaves behind, so a gauge
          // reading zero for a moment does not cut the trace in two.
          spanGaps: true,
          points: {
            // uPlot decides when the samples are far enough apart to be worth
            // marking; the ring in the surface colour keeps them legible where
            // two channels cross.
            size: 8,
            width: 2,
            stroke: surfaceColor(),
            fill: seriesColor(channel.index >= 0 ? channel.index : position),
          },
          value: (_self: uPlot, value: number | null) =>
            value == null ? "—" : `${formatTick(value)} ${unitLabel(channel.unit)}`,
        })),
      ],
      plugins: [
        watermarkPlugin(() => watermarkRef.current, () => watermarkAtRef.current),
        zoomPlugin({ onRange, onReset }),
      ],
    }
    // theme: the canvas colours are read when the options are built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, logY, yRange, unit, onRange, onReset, theme])

  // The window is owned outside the chart, so it is pushed in rather than
  // being whatever the data happens to span.
  useEffect(() => {
    plotRef.current?.setScale("x", { min: window.from, max: window.to })
  }, [window])

  // The watermark is read from a ref on each draw, so moving it has to ask for
  // one -- otherwise a chart of a file, which never redraws on its own, would
  // not move the number until something else made it repaint.
  useEffect(() => {
    plotRef.current?.redraw(false, false)
  }, [watermarkAt])

  return (
    <div
      // Refetching keeps the frame: the previous render stays up, dimmed,
      // rather than collapsing to a skeleton and jumping the layout.
      style={{ opacity: loading ? 0.65 : 1, transition: "opacity 120ms linear" }}
    >
      <UplotChart
        data={data}
        options={options}
        rebuildKey={rebuildKey}
        height={height}
        onCreate={(plot) => {
          plotRef.current = plot
          onPlot?.(plot)
          const { from, to } = windowRef.current
          plot.setScale("x", { min: from, max: to })
        }}
      />
    </div>
  )
}
