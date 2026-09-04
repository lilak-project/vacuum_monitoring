/** Formatting for the readouts.  Fixed width, so digits do not jump.
 *
 *  Pressure is the awkward one: a pumpdown runs from 1000 mbar to 1e-9 mbar,
 *  twelve decades, and no single fixed format is readable across them. So the
 *  exponent decides -- ordinary numbers stay ordinary, and only the very large
 *  and the very small go to scientific notation.
 */

/** Significant digits shown everywhere a measured value appears. */
const SIGNIFICANT = 4

/** Outside this exponent range, a number is easier to read as 1.23e-6. */
const PLAIN_MIN = 1e-2
const PLAIN_MAX = 1e5

export function formatValue(value: number | null | undefined, digits = SIGNIFICANT): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  const size = Math.abs(value)
  if (size < PLAIN_MIN || size >= PLAIN_MAX) {
    return value.toExponential(digits - 1)
  }
  return value.toPrecision(digits).replace(/\.?0+$/, "")
}

/**
 * For a chart's y axis, where the ticks must read as a scale, not as data.
 *
 * Takes null, and must: a log axis hides most of the ticks between decades by
 * passing `null` in their place, so a formatter that assumes a number throws
 * on the first one -- in the middle of uPlot's canvas draw, where no React
 * error boundary can catch it and the chart simply stops appearing.
 */
export function formatTick(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ""
  if (value === 0) return "0"
  const size = Math.abs(value)
  if (size < PLAIN_MIN || size >= PLAIN_MAX) {
    const exponent = Math.floor(Math.log10(size))
    const mantissa = value / 10 ** exponent
    const rounded = Math.round(mantissa)
    // A decade tick on a log axis is written 1e-6, not 1.000e-6.
    return Math.abs(mantissa - rounded) < 1e-9
      ? `${rounded}e${exponent}`
      : value.toExponential(1)
  }
  return String(Number(value.toPrecision(4)))
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["kB", "MB", "GB", "TB"]
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US")
}

/** "K" reads as a unit; "degC" has to be turned back into one. */
export function unitLabel(unit: string): string {
  if (unit === "degC") return "°C"
  if (unit === "degF") return "°F"
  return unit
}
