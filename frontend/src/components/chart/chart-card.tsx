import { useMemo, useRef } from "react"
import {
  Badge, Divider, Group, Loader, Paper, Select, Stack, Switch, Text, Tooltip,
} from "@mantine/core"
import { Download, ImageDown } from "lucide-react"
import type uPlot from "uplot"

import { downloadChartPng, downloadWindowCsv, stampedName } from "@/lib/download"
import { formatCount, unitLabel } from "@/lib/format"
import { formatDuration } from "@/lib/time"
import type { SeriesChannel } from "@/lib/types"

import { ChartBoundary } from "./chart-boundary"
import { hasPositiveValues, pointCounts } from "./chart-data"
import { RangeControls } from "./range-controls"
import { WatermarkPicker } from "./watermark-picker"
import { TimeBounds } from "./time-bounds"
import { TimeChart } from "./time-chart"
import type { WatermarkAt } from "./watermark-plugin"
import type { TimeRangeControl } from "./use-time-range"

/**
 * A chart with its own time axis controls, and a footer that says what is on
 * screen.
 *
 * That footer is the point of the card. A monitoring chart is a summary of far
 * more samples than it has pixels, and one drawn from every fourth row is a
 * different claim from one drawn from all of them. Rather than hide the
 * reduction, the card states it: how many points are drawn, how many are in
 * the window, and whether the file had to be skimmed to get here.
 */
export function ChartCard({
  channels,
  range,
  loading,
  error,
  availableUnits,
  unit,
  onUnitChange,
  logY,
  onLogYChange,
  dataStart,
  dataEnd,
  exportName,
  rowStride = 1,
  header,
  readouts,
  watermark,
  watermarkAt = "center",
  onWatermarkAtChange,
}: {
  channels: SeriesChannel[]
  range: TimeRangeControl
  loading: boolean
  error: string | null
  availableUnits: string[]
  /** "" means "whatever the device reported". */
  unit: string
  onUnitChange: (unit: string) => void
  /** Held outside so it survives a tab switch and is saved with the profile. */
  logY: boolean
  onLogYChange: (on: boolean) => void
  dataStart: number | null
  dataEnd: number | null
  exportName: string
  /** Above 1 when a file was read every nth row to stay affordable. */
  rowStride?: number
  header?: React.ReactNode
  /** The current values, shown above the chart they belong to. */
  readouts?: React.ReactNode
  /** The current reading, written large and grey behind the trace. */
  watermark?: string
  watermarkAt?: WatermarkAt
  onWatermarkAtChange?: (at: WatermarkAt) => void
}) {
  const plotRef = useRef<uPlot | null>(null)
  const canLogY = useMemo(() => hasPositiveValues(channels), [channels])
  const counts = useMemo(() => pointCounts(channels), [channels])

  const deviceUnit = channels[0]?.device_unit ?? ""
  const converted = channels.some((channel) => !channel.conversion.identity)
  const empty = counts.shown === 0

  return (
    <Paper withBorder p="lg" radius="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          {header}
          <Group gap="xs">
            {/* Beside the unit, because both answer "how am I reading this". */}
            <Tooltip
              label={
                canLogY
                  ? "Pressure spans decades; a linear axis flattens everything below rough vacuum"
                  : "Nothing in this window is above zero, so there is no log axis to draw"
              }
            >
              <div>
                <Switch
                  size="sm"
                  mr="xs"
                  checked={logY && canLogY}
                  disabled={!canLogY}
                  onChange={(event) => onLogYChange(event.currentTarget.checked)}
                  label="Log"
                />
              </div>
            </Tooltip>
            {/* Only offered where there is a reading behind the trace. */}
            {watermark && onWatermarkAtChange ? (
              <WatermarkPicker value={watermarkAt} onChange={onWatermarkAtChange} />
            ) : null}
            <Select
              size="sm"
              w={124}
              aria-label="Unit shown on the chart"
              value={unit || deviceUnit}
              onChange={(value) => onUnitChange(value ?? "")}
              data={availableUnits.map((item) => ({ value: item, label: unitLabel(item) }))}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
            <Tooltip label="Save the window on screen as a CSV">
              <Badge
                component="button"
                variant="default"
                size="lg"
                style={{ cursor: "pointer" }}
                leftSection={<Download size={13} />}
                onClick={() => downloadWindowCsv(channels, stampedName(exportName, "csv"))}
              >
                CSV
              </Badge>
            </Tooltip>
            <Tooltip label="Save the chart as a picture">
              <Badge
                component="button"
                variant="default"
                size="lg"
                style={{ cursor: "pointer" }}
                leftSection={<ImageDown size={13} />}
                onClick={() => {
                  const canvas = plotRef.current?.ctx.canvas
                  if (canvas) downloadChartPng(canvas, stampedName(exportName, "png"))
                }}
              >
                PNG
              </Badge>
            </Tooltip>
          </Group>
        </Group>

        {readouts}

        {/* One row of controls, above the chart they scope. */}
        <RangeControls range={range} />

        {/* One slot, one height (NEON rule 5): the chart, or the reason there is
            none, in the same place -- and a failed read laid over it rather
            than pushed in above it. */}
        <div className="vac-chartslot">
          {empty && !loading ? (
            <div className="vac-chartempty">
              <Text c="dimmed" size="sm">
                No samples in this window.
              </Text>
              <Text c="dimmed" size="xs">
                {/* Said plainly, because the two reasons need different actions:
                    a window before the device was opened, or a device that has
                    not read anything yet. */}
                Widen it or press All — or, if this device has only just been
                opened, wait a second for its first reading.
              </Text>
            </div>
          ) : (
            <ChartBoundary>
              <TimeChart
                channels={channels}
                window={range.window}
                logY={logY && canLogY}
                yRange={null}
                loading={loading}
                onRange={range.setWindow}
                onReset={range.reset}
                watermark={watermark}
                watermarkAt={watermarkAt}
                onPlot={(plot) => {
                  plotRef.current = plot
                }}
              />
            </ChartBoundary>
          )}
          {error ? (
            <div className="vac-chartfail tone-text-alarm" role="alert">
              ■ Could not read the samples: {error}
            </div>
          ) : null}
        </div>

        <Group gap="lg" wrap="wrap">
          <Text size="xs" c="dimmed">
            {formatDuration(range.window.to - range.window.from)} shown ·{" "}
            {counts.shown === counts.total ? (
              <>every one of {formatCount(counts.total)} samples</>
            ) : (
              <>
                {formatCount(counts.shown)} points drawn from {formatCount(counts.total)} samples
              </>
            )}
            {rowStride > 1 ? ` · read every ${rowStride}${ordinal(rowStride)} row of the file` : ""}
          </Text>
          {counts.shown < counts.total ? (
            <Text size="xs" c="dimmed">
              Reduced by keeping the highest and lowest of each interval, so a one-sample
              spike is still on the chart.
            </Text>
          ) : null}
          {converted ? (
            <Text size="xs" c="dimmed">
              {channels[0].conversion.description}
            </Text>
          ) : null}
          {/* Always in the row, seen only while loading: nothing shifts. */}
          <Loader size="xs" style={{ visibility: loading ? "visible" : "hidden" }} />
        </Group>

        <Text size="xs" c="dimmed">
          Drag across the chart to zoom to that interval · shift-drag to pan · double-click
          to go back · the wheel scrolls the page
        </Text>

        <Divider />

        {/* The fine adjustment, under the thing it adjusts. */}
        <TimeBounds range={range} dataStart={dataStart} dataEnd={dataEnd} />
      </Stack>
    </Paper>
  )
}

function ordinal(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return "th"
  return { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th"
}
