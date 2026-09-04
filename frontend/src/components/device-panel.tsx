import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Accordion, Alert, Badge, Button, Group, Paper, Stack, Text, Title, Tooltip,
} from "@mantine/core"
import { AlertTriangle, Expand, Pause, Play, Unplug, X } from "lucide-react"

import { ChartCard } from "@/components/chart/chart-card"
import { useTimeRange } from "@/components/chart/use-time-range"
import type { WatermarkAt } from "@/components/chart/watermark-plugin"
import { ProvenancePanel } from "@/components/provenance-panel"
import { ReadingFocus } from "@/components/reading-focus"
import { Readout } from "@/components/readout"
import { useProvenance } from "@/hooks/use-provenance"
import { useSeries, type SeriesQuery } from "@/hooks/use-series"
import { api } from "@/lib/api"
import { formatValue, unitLabel } from "@/lib/format"
import { seriesColor } from "@/lib/palette"
import { formatAgo, formatStamp } from "@/lib/time"
import type { DeviceSnapshot } from "@/lib/types"

/** How a device's status reads, and how alarming it should look. */
function statusTone(device: DeviceSnapshot): { color: string; label: string } {
  if (device.status === "error") return { color: "red", label: "Error" }
  if (device.source === "file") return { color: "gray", label: "From the files" }
  if (device.source === "remote") return { color: "teal", label: "Mirroring" }
  if (device.status === "open") return { color: "teal", label: "Reading" }
  return { color: "gray", label: "Closed" }
}

/**
 * One device: what it reads now, what it has been reading, and where that
 * comes from -- in that order, because that is the order the questions are
 * asked in.
 */
export function DevicePanel({
  device,
  unit,
  onUnitChange,
  logY,
  onLogYChange,
  watermarkAt,
  onWatermarkAtChange,
  onClose,
  closing,
}: {
  device: DeviceSnapshot
  /** "" means "whatever the instrument reports", which is the honest default:
   *  the chart should not silently be in different units from the gauge.
   *  Held by the app, not here — this panel unmounts on every tab switch, and
   *  a unit that resets when you look at another gauge is a unit you cannot
   *  trust. */
  unit: string
  onUnitChange: (unit: string) => void
  /** Kept outside for the same reason as the unit, and saved with the profile. */
  logY: boolean
  onLogYChange: (on: boolean) => void
  /** Which quarter of the plot the big grey reading sits in. */
  watermarkAt: WatermarkAt
  onWatermarkAtChange: (at: WatermarkAt) => void
  onClose: () => void
  closing: boolean
}) {
  const [channel, setChannel] = useState(0)
  const [focused, setFocused] = useState(false)

  const units = useMemo(() => {
    if (!unit) return {}
    return Object.fromEntries(device.channels.map((item) => [item.index, unit]))
  }, [unit, device.channels])

  const dataStart = useMemo(
    () =>
      device.channels.reduce<number | null>(
        (earliest, item) =>
          item.first_at == null ? earliest : Math.min(earliest ?? item.first_at, item.first_at),
        null,
      ),
    [device.channels],
  )

  const fromFiles = device.source === "file"
  // A file tab ends where its last row is; a live one ends now.
  const range = useTimeRange(dataStart, fromFiles ? (device.channels[0]?.last_at ?? null) : null)
  const fetcher = useCallback(
    (query: SeriesQuery) => api.series(device.id, query),
    [device.id],
  )
  const { data, loading, error, push } = useSeries(fetcher, range.window, units, {
    follow: range.follow && !fromFiles,
  })

  // A tab made of saved logs opens on everything it holds. The last ten
  // minutes of a run that finished in June is an empty chart, and following
  // the clock on a file that is not growing is following nothing.
  const dataEnd = device.channels[0]?.last_at ?? null
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (!fromFiles || seeded.current === device.id) return
    if (dataStart == null || dataEnd == null) return
    seeded.current = device.id
    range.setWindow(dataStart, dataEnd)
  }, [fromFiles, device.id, dataStart, dataEnd, range])

  // Every reading that arrives on the status socket goes straight onto the end
  // of the trace, so a live chart costs no requests between resyncs.
  const latestAt = device.channels[0]?.at ?? null
  const channelsRef = useRef(device.channels)
  channelsRef.current = device.channels
  useEffect(() => {
    if (fromFiles || latestAt == null) return
    push(
      latestAt,
      channelsRef.current.map((item) => item.value),
    )
  }, [fromFiles, latestAt, push])

  const { provenance } = useProvenance(device.id, units)
  const tone = statusTone(device)
  const channels = data?.series ?? []

  return (
    <Stack gap="lg">
      <Paper withBorder p="lg" radius="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
            <Group gap="sm" align="baseline" wrap="wrap">
              <Title order={2} fz="h3">
                {device.name}
              </Title>
              <Badge variant="light" color={tone.color} size="lg">
                {tone.label}
              </Badge>
              <Text size="sm" c="dimmed">
                {device.device_type}
                {provenance?.origin.port ? ` · ${provenance.origin.port}` : ""}
                {provenance?.origin.path ? ` · ${provenance.storage.filename}` : ""}
                {provenance?.origin.url ? ` · ${provenance.origin.url}` : ""}
              </Text>
            </Group>
            <Button
              variant="default"
              leftSection={fromFiles ? <X size={17} /> : <Unplug size={17} />}
              loading={closing}
              onClick={onClose}
            >
              {fromFiles ? "Close tab" : "Disconnect"}
            </Button>
          </Group>

          {device.last_error ? (
            <Alert color="red" icon={<AlertTriangle size={18} />} title="The last read failed">
              {device.last_error}
            </Alert>
          ) : null}

        </Stack>
      </Paper>

      <ChartCard
        channels={channels}
        range={range}
        loading={loading}
        error={error}
        availableUnits={provenance?.available_units ?? []}
        unit={unit}
        onUnitChange={onUnitChange}
        logY={logY}
        onLogYChange={onLogYChange}
        dataStart={dataStart}
        dataEnd={fromFiles ? (device.channels[0]?.last_at ?? null) : null}
        exportName={device.name}
        watermark={
          /* The same number as the readout above, at the scale of the trace.
             The unit is left off: it is printed twice already, on the readout
             and on the y axis, and dropping it lets the digits be half again
             as big -- which is the whole point of putting it there.
             One channel only, too -- eight Lake Shore readings written across
             each other would be a smear, not a reading. */
          device.channels.length === 1 && device.channels[0].value != null
            ? formatValue(convert(device.channels[0].value, provenance, device.channels[0].index))
            : undefined
        }
        watermarkAt={watermarkAt}
        onWatermarkAtChange={onWatermarkAtChange}
        readouts={
          /* The numbers, large, next to the chart that explains them. The
             reading is the point of the page, so it is set at hero size and
             everything else on the row stays secondary to it. */
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="xl">
            <Group gap="xl" align="flex-end" wrap="wrap">
              {device.channels.map((item) => (
                <Readout
                  key={item.index}
                  size="hero"
                  label={item.label}
                  color={seriesColor(item.index)}
                  value={formatValue(convert(item.value, provenance, item.index))}
                  unit={unitLabel(unit || item.unit)}
                />
              ))}
            </Group>
            <Group gap="sm" align="flex-end">
              <Readout
                label={fromFiles ? "Last row" : "Last reading"}
                value={fromFiles ? formatStamp(latestAt) : formatAgo(latestAt)}
              />
              {!fromFiles ? (
                <Tooltip
                  label={
                    range.follow
                      ? "Following the present"
                      : "Frozen — press to follow the present again"
                  }
                >
                  <Button
                    size="sm"
                    variant={range.follow ? "filled" : "default"}
                    color={range.follow ? "teal" : undefined}
                    leftSection={range.follow ? <Play size={15} /> : <Pause size={15} />}
                    onClick={() => range.setFollow(!range.follow)}
                  >
                    {range.follow ? "Live" : "Frozen"}
                  </Button>
                </Tooltip>
              ) : null}
              <Tooltip label="Show just the reading, filling the screen">
                <Button
                  size="sm"
                  variant="default"
                  leftSection={<Expand size={15} />}
                  onClick={() => setFocused(true)}
                >
                  Focus
                </Button>
              </Tooltip>
            </Group>
          </Group>
        }
        header={
          <Stack gap={0}>
            <Text fw={600} size="lg">
              {device.measure === "pressure" ? "Pressure" : "Temperature"}
            </Text>
            <Text size="sm" c="dimmed">
              {device.channels.length === 1
                ? device.channels[0].label
                : `${device.channels.length} channels`}{" "}
              · {device.name}
              {fromFiles && provenance?.origin.filenames
                ? ` · ${provenance.origin.filenames.length} file${provenance.origin.filenames.length === 1 ? "" : "s"}`
                : ""}
            </Text>
          </Stack>
        }
      />

      {/* Open by default: the whole point of the panel is that it is not
          hidden. It still folds away for someone only watching a number. */}
      <Accordion variant="separated" radius="lg" defaultValue="provenance">
        <Accordion.Item value="provenance">
          <Accordion.Control>
            <Text fw={600}>Where these numbers come from</Text>
            <Text size="sm" c="dimmed">
              The instrument, the channel, the arithmetic, and the file
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            {provenance ? (
              <ProvenancePanel
                provenance={provenance}
                channel={channel}
                onChannel={setChannel}
              />
            ) : (
              <Text c="dimmed" size="sm">
                Reading the device's details…
              </Text>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <ReadingFocus
        opened={focused}
        onClose={() => setFocused(false)}
        name={device.name}
        latestAt={latestAt}
        live={!fromFiles && device.status === "open"}
        channels={device.channels.map((item) => ({
          index: item.index,
          label: item.label,
          value: formatValue(convert(item.value, provenance, item.index)),
          unit: unitLabel(unit || item.unit),
        }))}
      />
    </Stack>
  )
}

/** The live readout has to make the same conversion the chart made. */
function convert(
  value: number | null,
  provenance: { channels: { index: number; conversion: { factor: number; offset: number } }[] } | null,
  index: number,
): number | null {
  if (value == null) return null
  const channel = provenance?.channels.find((item) => item.index === index)
  if (!channel) return value
  return value * channel.conversion.factor + channel.conversion.offset
}
