import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Accordion, Button, Group, Text, Tooltip } from "@mantine/core"
import { Choice, Hold, NoticeLine, Panel, Readout, StateDot, Tag, type Tone } from "@neon"
import { Expand, Unplug, X } from "lucide-react"

import { ChartCard } from "@/components/chart/chart-card"
import { useTimeRange } from "@/components/chart/use-time-range"
import type { WatermarkAt } from "@/components/chart/watermark-plugin"
import { ProvenancePanel } from "@/components/provenance-panel"
import { ReadingFocus } from "@/components/reading-focus"
import { useProvenance } from "@/hooks/use-provenance"
import { useSeries, type SeriesQuery } from "@/hooks/use-series"
import { api } from "@/lib/api"
import { formatValue, unitLabel } from "@/lib/format"
import { seriesColor } from "@/lib/palette"
import { formatAgo, formatStamp } from "@/lib/time"
import type { DeviceSnapshot } from "@/lib/types"

/** How a device's status reads, and in which tone (every wording reserved: rule 5). */
const STATUS_WORDS = ["error", "from the files", "mirroring", "reading", "closed"]
function statusTone(device: DeviceSnapshot): { tone: Tone; label: string } {
  if (device.status === "error") return { tone: "alarm", label: "error" }
  if (device.source === "file") return { tone: "idle", label: "from the files" }
  if (device.source === "remote") return { tone: "ok", label: "mirroring" }
  if (device.status === "open") return { tone: "ok", label: "reading" }
  return { tone: "idle", label: "closed" }
}

/** The widest a reading gets: four significant digits, signed, in exponent form. */
const WIDEST = "-8.888e-88"

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
  /** Absent while monitoring: no Disconnect is drawn. */
  onClose?: () => void
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

  const from =
    provenance?.origin.port ?? (provenance?.origin.path ? provenance.storage.filename : null) ?? provenance?.origin.url ?? null

  return (
    <div className="vac-stack">
      <Panel
        title={
          // What this device IS -- its type, where it is read from -- as fixed
          // tags (NEON rule 4); its state as a held dot (rule 5).
          <span className="vac-tags">
            {device.name}
            <Tag label="TYPE">{device.device_type}</Tag>
            {from ? <Tag label="FROM">{from}</Tag> : null}
          </span>
        }
        actions={
          <span className="vac-keys">
            <StateDot tone={tone.tone} reserve={STATUS_WORDS}>
              {tone.label}
            </StateDot>
            {onClose ? (
              <Button
                variant="default"
                leftSection={fromFiles ? <X size={16} /> : <Unplug size={16} />}
                loading={closing}
                onClick={onClose}
              >
                {fromFiles ? "Close tab" : "Disconnect"}
              </Button>
            ) : null}
          </span>
        }
      >
        {/* The last read's failure: a line that is always there (rule 5), so
            a failure fills it in place instead of pushing the chart down. */}
        <NoticeLine tone={device.last_error ? "alarm" : null}>
          {device.last_error ? `The last read failed: ${device.last_error}` : fromFiles ? "Read from saved logs" : "Last read OK"}
        </NoticeLine>
      </Panel>

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
                  label={
                    <>
                      <span className="vac-swatch" style={{ background: seriesColor(item.index) }} />
                      {item.label}
                    </>
                  }
                  value={<Hold reserve={[WIDEST]}>{formatValue(convert(item.value, provenance, item.index))}</Hold>}
                  unit={unitLabel(unit || item.unit)}
                />
              ))}
            </Group>
            <Group gap="sm" align="flex-end">
              <Readout
                label={fromFiles ? "Last row" : "Last reading"}
                value={
                  <Hold reserve={fromFiles ? ["8888-88-88 88:88:88"] : ["just now", "59 min ago", "23 h ago", "never"]}>
                    {fromFiles ? formatStamp(latestAt) : formatAgo(latestAt)}
                  </Hold>
                }
                size="text"
              />
              {!fromFiles ? (
                // Following the present, or holding still to read: picked, it slides.
                <Choice
                  value={range.follow ? "live" : "frozen"}
                  onChange={(v) => range.setFollow(v === "live")}
                  options={[
                    { value: "live", label: "Live" },
                    { value: "frozen", label: "Frozen" },
                  ]}
                />
              ) : null}
              <Tooltip label="Show just the reading, filling the screen">
                <Button variant="default" leftSection={<Expand size={15} />} onClick={() => setFocused(true)}>
                  Focus
                </Button>
              </Tooltip>
            </Group>
          </Group>
        }
        header={
          <Group gap="sm" align="baseline">
            <Text fw={600}>
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
          </Group>
        }
      />

      {/* Open by default: the whole point of the panel is that it is not
          hidden. It still folds away for someone only watching a number. */}
      <Accordion variant="separated" defaultValue="provenance">
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
    </div>
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
