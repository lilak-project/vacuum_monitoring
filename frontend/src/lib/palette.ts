/**
 * Series colours.
 *
 * These eight are the validated categorical set from the data-visualisation
 * reference palette, in its fixed order. They are assigned to channels in
 * sequence and never cycled or re-ordered: the order is what makes the set
 * safe for red-green colour blindness, so changing it breaks the guarantee.
 *
 * Checked against this page's white surface with the palette validator:
 * lightness band, chroma floor, contrast, and colour-vision separation all
 * pass — worst adjacent pair ΔE 9.1 under protanopia, 19.6 under normal
 * vision. Three of them (aqua, yellow, magenta) sit below 3:1 contrast on
 * white, which is allowed only because every value is also readable without
 * the colour: the live legend names each channel beside its number, the
 * readout above the chart repeats it, and the Data panel lists the samples
 * themselves.
 */
export const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const

/** The colour for channel `index`.  Never cycles: see above. */
export function seriesColor(index: number): string {
  return SERIES_COLORS[index] ?? "#868e96"
}

/** Chart chrome, one step off the surface so it stays recessive. */
export const AXIS_COLOR = "#868e96"
export const GRID_COLOR = "#e9ecef"
export const TICK_COLOR = "#dee2e6"
