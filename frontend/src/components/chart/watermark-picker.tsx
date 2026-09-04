import { ActionIcon, Group, Tooltip } from "@mantine/core"
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Circle } from "lucide-react"

import type { WatermarkAt } from "./watermark-plugin"

/**
 * Where the big grey reading sits.
 *
 * It has to be movable because the trace decides where the space is: a chamber
 * holding steady near the top of the axis leaves the bottom empty, and one
 * pumping down leaves the top. A number that cannot move ends up crossed out
 * by the very line it is meant to sit beside.
 *
 * Laid out the way the choices are: the corners in their corners, the middle
 * in the middle.
 */
const CHOICES: { at: WatermarkAt; icon: React.ReactNode; label: string }[] = [
  { at: "top-left", icon: <ArrowUpLeft size={15} />, label: "Reading in the top left" },
  { at: "bottom-left", icon: <ArrowDownLeft size={15} />, label: "Reading in the bottom left" },
  { at: "center", icon: <Circle size={13} />, label: "Reading across the whole plot" },
  { at: "top-right", icon: <ArrowUpRight size={15} />, label: "Reading in the top right" },
  { at: "bottom-right", icon: <ArrowDownRight size={15} />, label: "Reading in the bottom right" },
]

export function WatermarkPicker({
  value,
  onChange,
}: {
  value: WatermarkAt
  onChange: (at: WatermarkAt) => void
}) {
  return (
    <Group gap={2}>
      {CHOICES.map((choice) => (
        <Tooltip key={choice.at} label={choice.label}>
          <ActionIcon
            size="md"
            variant={value === choice.at ? "filled" : "subtle"}
            color={value === choice.at ? "blue" : "gray"}
            aria-label={choice.label}
            onClick={() => onChange(choice.at)}
          >
            {choice.icon}
          </ActionIcon>
        </Tooltip>
      ))}
    </Group>
  )
}
