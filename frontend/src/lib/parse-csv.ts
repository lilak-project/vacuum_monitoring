import type { SeriesChannel } from "./types"

/**
 * Read a measurement CSV in the browser.
 *
 * For opening a file that is not on this machine -- one copied off a memory
 * stick, or mailed over. It understands both headers the service knows: the
 * one it writes, and the one cmms-web and the original CMMS program wrote.
 *
 * Deliberately not a general CSV parser. These files are written by two known
 * programs, neither of which quotes or embeds newlines, so a split is correct
 * and a parser would only be slower on the sixty-megabyte ones.
 */
export interface ParsedCsv {
  name: string
  measure: "pressure" | "temperature"
  format: "vacuum_monitoring" | "cmms" | "unknown"
  deviceType: string
  channels: SeriesChannel[]
  rows: number
}

const identity = { factor: 1, offset: 0, identity: true, description: "as recorded" }

export function parseCsv(text: string, filename: string): ParsedCsv {
  const lines = text.split(/\r?\n/)
  const header = (lines[0] ?? "").split(",").map((cell) => cell.trim())
  const column = (name: string) => header.indexOf(name)

  const timeAt = column("unix_time")
  const channelAt = column("channel")
  const valueAt = column("value") >= 0 ? column("value") : column("pressure_raw")
  const unitAt = column("unit") >= 0 ? column("unit") : column("raw_unit")
  const labelAt = column("channel_label")
  const format =
    column("value") >= 0 ? "vacuum_monitoring" : column("pressure_raw") >= 0 ? "cmms" : "unknown"

  if (timeAt < 0 || valueAt < 0) {
    throw new Error(
      "That file has no `unix_time` and no value column, so it is not a measurement log.",
    )
  }

  const measureAt = column("measure")
  const typeAt = column("device_type")
  const buckets = new Map<number, { label: string; unit: string; t: number[]; v: number[] }>()
  let measure: ParsedCsv["measure"] = "pressure"
  let deviceType = ""
  let rows = 0

  for (let line = 1; line < lines.length; line += 1) {
    const cells = lines[line].split(",")
    if (cells.length <= valueAt) continue
    const at = Number(cells[timeAt])
    const value = Number(cells[valueAt])
    if (!Number.isFinite(at) || !Number.isFinite(value)) continue
    rows += 1

    const index = Math.max(0, (Number(cells[channelAt]) || 1) - 1)
    let bucket = buckets.get(index)
    if (!bucket) {
      bucket = {
        label: (labelAt >= 0 ? cells[labelAt] : "") || `CH${index + 1}`,
        unit: (unitAt >= 0 ? cells[unitAt] : "") || "",
        t: [],
        v: [],
      }
      buckets.set(index, bucket)
    }
    bucket.t.push(at)
    bucket.v.push(value)

    if (measureAt >= 0 && cells[measureAt] === "temperature") measure = "temperature"
    if (typeAt >= 0 && !deviceType) deviceType = cells[typeAt] ?? ""
  }

  const channels: SeriesChannel[] = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, bucket]) => ({
      index,
      label: bucket.label,
      unit: bucket.unit,
      device_unit: bucket.unit,
      conversion: identity,
      t: bucket.t,
      v: bucket.v,
      total: bucket.t.length,
      decimated: false,
    }))

  return {
    name: filename.replace(/\.csv$/i, ""),
    measure,
    format,
    deviceType,
    channels,
    rows,
  }
}

/** Cut a parsed file down to a window, and to what a chart can draw.
 *
 *  The same min/max reduction the server does, so a local file and a served
 *  one are read the same way -- including keeping one-sample spikes. */
export function sliceChannels(
  channels: SeriesChannel[],
  from: number,
  to: number,
  maxPoints: number,
): SeriesChannel[] {
  return channels.map((channel) => {
    const t: number[] = []
    const v: number[] = []
    for (let i = 0; i < channel.t.length; i += 1) {
      const at = channel.t[i]
      if (at < from) continue
      if (at > to) break
      t.push(at)
      v.push(channel.v[i])
    }
    const total = t.length
    if (total <= maxPoints || maxPoints < 4) {
      return { ...channel, t, v, total, decimated: false }
    }

    const buckets = Math.floor(maxPoints / 2)
    const outT: number[] = []
    const outV: number[] = []
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const lo = Math.floor((total * bucket) / buckets)
      const hi = Math.floor((total * (bucket + 1)) / buckets)
      if (lo >= hi) continue
      let lowAt = lo
      let highAt = lo
      for (let i = lo + 1; i < hi; i += 1) {
        if (v[i] < v[lowAt]) lowAt = i
        else if (v[i] > v[highAt]) highAt = i
      }
      const first = Math.min(lowAt, highAt)
      const second = Math.max(lowAt, highAt)
      outT.push(t[first])
      outV.push(v[first])
      if (second !== first) {
        outT.push(t[second])
        outV.push(v[second])
      }
    }
    return { ...channel, t: outT, v: outV, total, decimated: true }
  })
}
