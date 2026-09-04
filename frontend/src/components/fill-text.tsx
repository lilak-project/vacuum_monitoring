/**
 * Text scaled to fill its box exactly.
 *
 * CSS cannot size type to fit -- `vw` guesses from the viewport, not from the
 * string, so a four-character reading and a nine-character one come out at the
 * same size and one of them is wrong. An SVG viewBox sized to the string does
 * the fitting in the renderer: the box is the text's own proportions, and
 * `preserveAspectRatio` scales it to whatever space it is given.
 *
 * The width estimate only has to be proportional, and for a monospaced face it
 * is exact: every glyph advances the same fraction of the em.
 */
const ADVANCE = 0.6
const EM = 100

export function FillText({
  children,
  color,
  weight = 600,
  height,
}: {
  children: string
  color?: string
  weight?: number
  /** CSS height of the box the text fills; width comes from its parent. */
  height: string | number
}) {
  const text = children || " "
  const width = Math.max(1, text.length) * EM * ADVANCE

  return (
    <svg
      viewBox={`0 0 ${width} ${EM}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", width: "100%", height }}
      role="img"
      aria-label={text}
    >
      <text
        x={width / 2}
        y={EM * 0.74}
        textAnchor="middle"
        fontSize={EM}
        fontWeight={weight}
        fill={color ?? "currentColor"}
        fontFamily='"Geist Mono Variable", ui-monospace, SFMono-Regular, monospace'
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {text}
      </text>
    </svg>
  )
}
