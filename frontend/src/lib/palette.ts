// neon:allow-colour — fallbacks only: a NEON page sets every --neon-* these read.
/**
 * Chart colours, from the NEON tokens: the series set (--neon-series-1…8, the
 * one exception to NEON's two colours -- several traces need hues) and the
 * chart chrome (dim axis, grid, line, panel). Read when a chart is built, so a
 * theme change rebuilds it in the new colours (time-chart.tsx, useTheme).
 *
 * Assigned to channels in order and never cycled: a set of eight stays
 * distinguishable; a ninth would not be.
 */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** The colour for channel `index`.  Never cycles: see above. */
export function seriesColor(index: number): string {
  return index >= 0 && index < 8 ? cssVar(`--neon-series-${index + 1}`, "#19f0ff") : cssVar("--neon-dim", "#9391a8")
}

/** Chart chrome, one step off the surface so it stays recessive. */
export const axisColor = () => cssVar("--neon-dim", "#9391a8")
export const gridColor = () => cssVar("--neon-grid", "#1a1a26")
export const tickColor = () => cssVar("--neon-line", "#3a3a52")
export const surfaceColor = () => cssVar("--neon-panel", "#12121a")
export const chartFont = () => `13px "IBM Plex Sans", "Pretendard", -apple-system, sans-serif`
