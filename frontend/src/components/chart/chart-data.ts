import type uPlot from "uplot"

import type { SeriesChannel } from "@/lib/types"

/**
 * Turn the per-channel series the API returns into uPlot's aligned form.
 *
 * uPlot wants one x array shared by every series. The channels of a device are
 * read in the same sweep, so before decimation they do share timestamps -- but
 * min/max decimation picks each channel's own extremes, so afterwards they do
 * not. Rather than lose those extremes by forcing a common grid, the union of
 * the timestamps is taken and each channel is filled with nulls where it has
 * no sample. `spanGaps` then draws through them, so the line is continuous and
 * every peak that was in the data is still on the screen.
 *
 * The usual case -- one channel, or several that decimated identically -- is
 * detected and passes straight through with no union built at all.
 */
export function toAligned(
  channels: SeriesChannel[],
  options: { logY: boolean },
): uPlot.AlignedData {
  if (channels.length === 0) return [[]]

  const shared = channels.every((channel) => sameTimes(channel.t, channels[0].t))
  if (shared) {
    return [channels[0].t, ...channels.map((channel) => plotValues(channel.v, options.logY))] as
      uPlot.AlignedData
  }

  const union = Array.from(new Set(channels.flatMap((channel) => channel.t))).sort((a, b) => a - b)
  const position = new Map(union.map((time, index) => [time, index]))
  const rows = channels.map((channel) => {
    const row: (number | null)[] = Array.from({ length: union.length }, () => null)
    for (let i = 0; i < channel.t.length; i += 1) {
      const at = position.get(channel.t[i])
      if (at !== undefined) row[at] = channel.v[i]
    }
    return plotValues(row, options.logY)
  })
  return [union, ...rows] as uPlot.AlignedData
}

/** A log axis cannot draw zero or a negative reading, so those become gaps.
 *
 *  This matters on a real gauge: a TPG reports 0 for a sensor that is switched
 *  off, and plotting that as a value would put a floor on the chart that no
 *  measurement ever produced. */
function plotValues(values: (number | null)[], logY: boolean): (number | null)[] {
  if (!logY) return values
  return values.map((value) => (value != null && value > 0 ? value : null))
}

function sameTimes(a: number[], b: number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** True when a log axis would have anything at all to draw. */
export function hasPositiveValues(channels: SeriesChannel[]): boolean {
  return channels.some((channel) => channel.v.some((value) => value != null && value > 0))
}

/** Points on screen across every channel, for the "showing N of M" line. */
export function pointCounts(channels: SeriesChannel[]): { shown: number; total: number } {
  return channels.reduce(
    (sum, channel) => ({ shown: sum.shown + channel.t.length, total: sum.total + channel.total }),
    { shown: 0, total: 0 },
  )
}
