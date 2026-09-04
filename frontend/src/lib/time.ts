/** Time axis helpers: the presets, and reading and writing absolute stamps. */

export interface RangePreset {
  id: string
  label: string
  /** Width of the window in seconds; null means "everything there is". */
  seconds: number | null
}

/** The windows an operator actually asks for, shortest first.
 *
 *  Ten minutes is "what is it doing right now", a day is "what did it do
 *  overnight", and All is the whole record. Anything between those is one drag
 *  on the chart away, so the row stays short enough to hit without looking.
 */
export const RANGE_PRESETS: RangePreset[] = [
  { id: "10m", label: "10 m", seconds: 600 },
  { id: "1h", label: "1 h", seconds: 3600 },
  { id: "24h", label: "24 h", seconds: 24 * 3600 },
  { id: "all", label: "All", seconds: null },
]

const pad = (value: number) => String(value).padStart(2, "0")

/** "14:32:10" -- for a tick or a cursor, where the date is already known. */
export function formatClock(seconds: number, withSeconds = true): string {
  const date = new Date(seconds * 1000)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return withSeconds ? `${time}:${pad(date.getSeconds())}` : time
}

/** "2026-08-29 14:32:10" -- the form the from/to boxes read and write. */
export function formatStamp(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return ""
  const date = new Date(seconds * 1000)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Read a time out of the from/to box.
 *
 * Typing a full stamp is slow, and an operator narrowing a window already
 * knows the day. So a bare time means today, and the seconds are optional.
 * Returns null for anything that is not a time, which the box shows as an
 * error rather than silently ignoring.
 */
export function parseStamp(text: string, reference = Date.now() / 1000): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const full = trimmed.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  )
  if (full) {
    const [, y, mo, d, h, mi, s] = full
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
    )
    return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000
  }

  const timeOnly = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (timeOnly) {
    const [, h, mi, s] = timeOnly
    const day = new Date(reference * 1000)
    day.setHours(Number(h), Number(mi), Number(s ?? 0), 0)
    return day.getTime() / 1000
  }

  return null
}

/** "3.2 h" -- a span, in whichever unit keeps it to two or three characters. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} d`
}

/** "4 s ago" -- how stale a reading is, which is the thing worth knowing. */
export function formatAgo(at: number | null | undefined, now = Date.now() / 1000): string {
  if (at == null || !Number.isFinite(at)) return "never"
  const seconds = now - at
  if (seconds < 0) return "just now"
  if (seconds < 2) return "just now"
  return `${formatDuration(seconds)} ago`
}
