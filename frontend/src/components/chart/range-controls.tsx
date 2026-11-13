import { ActionIcon, Group, Tooltip } from "@mantine/core"
import { Choice } from "@neon"
import { ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from "lucide-react"

import { RANGE_PRESETS } from "@/lib/time"

import type { TimeRangeControl } from "./use-time-range"

/**
 * The window, as one row of buttons.
 *
 * The presets are widths; **All** is not — it is however much there is, which
 * can be a minute or four months. It sits last, after the widths.
 */
export function RangeControls({ range }: { range: TimeRangeControl }) {
  return (
    <Group gap="sm" wrap="wrap">
      {/* A picked width slides over; a hand-zoomed window lights none. */}
      <Choice
        options={RANGE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
        value={range.presetId}
        onChange={(id) => range.choosePreset(id)}
      />

      <Group gap={4}>
        {/* Greyed at the ends rather than sliding into blank axis: an empty
            chart reads as "the gauge stopped", not "there is nothing here". */}
        <IconButton
          label={range.atStart ? "This is the oldest reading there is" : "Back one half window"}
          disabled={range.atStart}
          onClick={() => range.pan(-0.5)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => range.zoom(2)}>
          <ZoomOut size={17} />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => range.zoom(0.5)}>
          <ZoomIn size={17} />
        </IconButton>
        <IconButton
          label={range.atEnd ? "This is the newest reading there is" : "Forward one half window"}
          disabled={range.atEnd}
          onClick={() => range.pan(0.5)}
        >
          <ChevronRight size={18} />
        </IconButton>
        <IconButton label="Back to the preset window" onClick={range.reset}>
          <RotateCcw size={16} />
        </IconButton>
      </Group>
    </Group>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      {/* A disabled control fires no events, so the tooltip needs a wrapper
          that does -- otherwise the reason it is disabled is unreadable. */}
      <div>
        <ActionIcon
          size={36}
          variant="default"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </ActionIcon>
      </div>
    </Tooltip>
  )
}
