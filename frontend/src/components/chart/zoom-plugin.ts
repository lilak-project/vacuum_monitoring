import type uPlot from "uplot"

/**
 * Direct manipulation of the time axis: drag to select, shift-drag to pan,
 * double-click to go back. The wheel is left alone: it scrolls the page
 * (zoom is the buttons beside the chart).
 *
 * None of it changes the scale itself. Every gesture reports the range it
 * means and the owner of the chart decides -- which is what lets a zoom go
 * back to the server for the samples inside the new window, instead of
 * magnifying the handful already on screen.
 */
export interface ZoomHandlers {
  /** A new [from, to] in unix seconds. */
  onRange: (from: number, to: number) => void
  /** Double-click: back to whatever the chart considers its default. */
  onReset: () => void
}

/** Smallest window a gesture may produce: ten seconds of a 1 Hz log. */
const MIN_SPAN = 10


export function zoomPlugin(handlers: ZoomHandlers): uPlot.Plugin {
  let detach: (() => void) | null = null

  return {
    hooks: {
      ready(plot: uPlot) {
        const over = plot.over
        let panning: { x: number; min: number; max: number } | null = null

        const onMouseDown = (event: MouseEvent) => {
          if (!event.shiftKey) return
          const { min, max } = plot.scales.x
          if (min == null || max == null) return
          // Stop uPlot starting a selection: this gesture is a pan.
          event.preventDefault()
          event.stopPropagation()
          panning = { x: event.clientX, min, max }
          over.style.cursor = "grabbing"
        }

        const onMouseMove = (event: MouseEvent) => {
          if (!panning) return
          const span = panning.max - panning.min
          // bbox is in canvas pixels; the mouse moves in CSS pixels.
          const perPixel = (span * devicePixelRatio) / plot.bbox.width
          const shift = (panning.x - event.clientX) * perPixel
          handlers.onRange(panning.min + shift, panning.max + shift)
        }

        const onMouseUp = () => {
          if (!panning) return
          panning = null
          over.style.cursor = ""
        }

        const onDoubleClick = () => handlers.onReset()

        over.addEventListener("mousedown", onMouseDown)
        over.addEventListener("dblclick", onDoubleClick)
        // On the window, not the plot: a drag that leaves the chart should
        // still pan, and still end when the button comes up outside it.
        window.addEventListener("mousemove", onMouseMove)
        window.addEventListener("mouseup", onMouseUp)

        detach = () => {
          over.removeEventListener("mousedown", onMouseDown)
          over.removeEventListener("dblclick", onDoubleClick)
          window.removeEventListener("mousemove", onMouseMove)
          window.removeEventListener("mouseup", onMouseUp)
        }
      },

      /** Drag released.  `cursor.drag.setScale` is off, so this is the only
       *  thing that acts on the rectangle uPlot just drew. */
      setSelect(plot: uPlot) {
        const { left, width } = plot.select
        if (width < 4) return // a click, not a drag
        const from = plot.posToVal(left, "x")
        const to = plot.posToVal(left + width, "x")
        plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
        if (to - from >= MIN_SPAN) handlers.onRange(from, to)
      },

      destroy() {
        detach?.()
        detach = null
      },
    },
  }
}
