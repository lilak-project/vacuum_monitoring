import { useEffect, useRef } from "react"
import uPlot from "uplot"

/**
 * uPlot in a React component.
 *
 * uPlot is imperative and owns its canvas, so this deliberately does not
 * re-render it: the plot is built once and then fed. Rebuilding on every data
 * tick would throw away the cursor, the selection, and any zoom the operator
 * had just made -- which on a chart updating once a second is the difference
 * between usable and not.
 *
 * `rebuildKey` is the escape hatch: change it and the plot is torn down and
 * built again. It should carry everything that cannot be set after the fact --
 * how many series there are, what they are called, whether the y axis is
 * logarithmic.
 */
export function UplotChart({
  data,
  options,
  rebuildKey,
  height,
  onCreate,
}: {
  data: uPlot.AlignedData
  options: Omit<uPlot.Options, "width" | "height">
  rebuildKey: string
  height: number
  onCreate?: (plot: uPlot) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Read inside the build effect without making it a dependency: neither
  // should cause a rebuild, and the latest is always what we want.
  const dataRef = useRef(data)
  const optionsRef = useRef(options)
  const createRef = useRef(onCreate)
  dataRef.current = data
  optionsRef.current = options
  createRef.current = onCreate

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const plot = new uPlot(
      { ...optionsRef.current, width: host.clientWidth || 800, height },
      dataRef.current,
      host,
    )
    plotRef.current = plot
    createRef.current?.(plot)

    // The chart fills the panel, and the panel follows the window.
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width)
      if (width > 0) plot.setSize({ width, height })
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [rebuildKey, height])

  useEffect(() => {
    // `false` keeps the x scale where the operator put it; the range is driven
    // from outside, not re-derived from whatever data happened to arrive.
    plotRef.current?.setData(data, false)
  }, [data])

  return <div className="chart-host" ref={hostRef} />
}
