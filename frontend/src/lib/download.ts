/** Handing the operator a file: the visible window, as data or as a picture. */

import { formatStamp } from "./time"
import type { SeriesChannel } from "./types"

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * The window on screen, as a CSV.
 *
 * Written wide -- one row per instant, one column per channel -- because that
 * is the shape a plotting program or a spreadsheet wants, and it is the shape
 * the chart is in. Channels that decimated to different instants leave blanks
 * rather than being resampled onto a grid they were never measured on.
 */
export function downloadWindowCsv(
  channels: SeriesChannel[],
  filename: string,
): void {
  const union = Array.from(new Set(channels.flatMap((channel) => channel.t))).sort((a, b) => a - b)
  const lookup = channels.map((channel) => {
    const map = new Map<number, number>()
    channel.t.forEach((at, index) => map.set(at, channel.v[index]))
    return map
  })

  const header = [
    "time",
    "unix_time",
    ...channels.map((channel) => `${channel.label} (${channel.unit})`),
  ]
  const rows = union.map((at) => [
    formatStamp(at),
    at.toFixed(3),
    ...lookup.map((map) => {
      const value = map.get(at)
      return value === undefined ? "" : String(value)
    }),
  ])

  const body = [header, ...rows]
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .join("\n")
  save(new Blob([`${body}\n`], { type: "text/csv;charset=utf-8" }), filename)
}

/**
 * The chart as a picture, for a logbook entry or a message.
 *
 * uPlot's canvas is transparent, so it is composited onto white first --
 * otherwise the trace lands on whatever the reader's viewer puts behind it,
 * and a dark one swallows the axes.
 */
export function downloadChartPng(canvas: HTMLCanvasElement, filename: string): void {
  const sheet = document.createElement("canvas")
  sheet.width = canvas.width
  sheet.height = canvas.height
  const context = sheet.getContext("2d")
  if (!context) return
  // The panel's own colour behind the traces, so the picture matches the screen.
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--neon-panel").trim() || "white"
  context.fillRect(0, 0, sheet.width, sheet.height)
  context.drawImage(canvas, 0, 0)
  sheet.toBlob((blob) => {
    if (blob) save(blob, filename)
  }, "image/png")
}

/** A filename that says what it is and when it was taken. */
export function stampedName(base: string, extension: string): string {
  const stamp = formatStamp(Date.now() / 1000).replace(/[: ]/g, "-")
  return `${base.replace(/[^A-Za-z0-9_-]+/g, "_")}_${stamp}.${extension}`
}
