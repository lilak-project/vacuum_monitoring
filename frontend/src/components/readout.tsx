import { Box, Text } from "@mantine/core"

/**
 * A label above a monospaced value.
 *
 * `size="hero"` is for the reading itself, which is what the page is for;
 * everything else on the panel exists to explain it. The rest are the
 * secondary numbers. For the reading filling a screen, see `FillText`.
 */
export function Readout({
  label,
  value,
  unit,
  color,
  size = "md",
}: {
  label: string
  value: string
  unit?: string
  /** The series colour, when this readout belongs to a line on the chart. */
  color?: string
  size?: "md" | "hero"
}) {
  const type = {
    md: { value: "lg", unit: "sm", label: "xs" },
    hero: { value: "2.6rem", unit: "1.2rem", label: "sm" },
  }[size]

  return (
    <Box>
      <Text size={type.label} c="dimmed" fw={500}>
        {/* The swatch ties the number to its trace, and is never the only
            thing carrying that -- the label is right beside it. */}
        {color ? (
          <Box
            component="span"
            mr={6}
            style={{
              display: "inline-block",
              width: size === "md" ? 10 : 16,
              height: 3,
              borderRadius: 2,
              background: color,
              verticalAlign: "middle",
            }}
          />
        ) : null}
        {label}
      </Text>
      <Text className="tabular" fz={type.value} fw={600} lh={1.1}>
        {value}
        {unit ? (
          <Text span fz={type.unit} c="dimmed" fw={400} ml={size === "md" ? 4 : 10}>
            {unit}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}
