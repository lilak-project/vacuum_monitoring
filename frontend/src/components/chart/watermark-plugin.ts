import type uPlot from "uplot"

/** Where the reading is written: filling the plot, or in one quarter of it. */
export type WatermarkAt = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"

export const WATERMARK_POSITIONS: WatermarkAt[] = [
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]

/**
 * The current reading, written across the plot in grey behind the trace.
 *
 * A monitoring chart is usually read from further away than a chart, and from
 * that distance the shape of the line arrives long before any number on the
 * axis does. This puts the number at the same scale as the shape, so "what is
 * it now" and "what has it been doing" are one glance instead of two -- and it
 * costs no space, because it is in space the chart was not using.
 *
 * Which space, though, depends on the trace: a line sitting high across the
 * plot wants the number underneath it. Hence the corners. In a corner the
 * number is sized to that quarter, so moving it out of the way actually moves
 * it out of the way rather than just shifting a full-width number sideways.
 *
 * Drawn in `drawClear`, which fires after the canvas is cleared and before the
 * axes and the series, so the trace always sits on top and nothing the number
 * says can hide a reading.
 */
export function watermarkPlugin(
  text: () => string,
  position: () => WatermarkAt,
): uPlot.Plugin {
  return {
    hooks: {
      drawClear(plot: uPlot) {
        const label = text()
        if (!label) return

        const { left, top, width, height } = plot.bbox
        if (width <= 0 || height <= 0) return

        const at = position()
        const box =
          at === "center"
            ? { x: left, y: top, w: width, h: height }
            : {
                x: at.endsWith("right") ? left + width / 2 : left,
                y: at.startsWith("bottom") ? top + height / 2 : top,
                w: width / 2,
                h: height / 2,
              }

        const ctx = plot.ctx
        ctx.save()
        // Clipped to the plot area so it never runs out over the axes.
        ctx.beginPath()
        ctx.rect(left, top, width, height)
        ctx.clip()

        // Big enough to fill its box, but never wider than it: the size is
        // whichever of the two limits bites first.
        ctx.font = `600 100px ${FONT_STACK}`
        const widthAt100 = ctx.measureText(label).width || 1
        const size = Math.max(
          12,
          Math.min(box.h * 0.62, (box.w * 0.92 * 100) / widthAt100),
        )

        ctx.font = `600 ${size}px ${FONT_STACK}`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        // Light enough that a 2px trace crossing it is still the darker thing
        // on the screen, dark enough to read across a room.
        ctx.fillStyle = "rgba(33, 37, 41, 0.22)"
        ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2)
        ctx.restore()
      },
    },
  }
}

/** The monospaced face the readouts use, so the two agree at a glance. */
const FONT_STACK = '"Geist Mono Variable", ui-monospace, SFMono-Regular, monospace'
