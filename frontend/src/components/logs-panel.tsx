import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Alert, Anchor, Badge, Button, FileButton, Group, Paper, ScrollArea, Stack, Table, Text,
} from "@mantine/core"
import { AlertTriangle, Download, FolderOpen, RefreshCw } from "lucide-react"

import { ChartCard } from "@/components/chart/chart-card"
import { useTimeRange } from "@/components/chart/use-time-range"
import { Fact, FactGrid, Section } from "@/components/section"
import { useSeries, type SeriesQuery } from "@/hooks/use-series"
import { api, errorMessage } from "@/lib/api"
import { formatBytes, formatCount } from "@/lib/format"
import { parseCsv, sliceChannels, type ParsedCsv } from "@/lib/parse-csv"
import { formatDuration, formatStamp } from "@/lib/time"
import type { LogList, LogMeta, SeriesResponse } from "@/lib/types"

/**
 * The logs on disk, and any CSV the operator drops in.
 *
 * A saved log is plotted on exactly the same terms as a live device -- the
 * same window controls, the same decimation, the same statement of how much
 * was read -- because "what did it do last Tuesday" and "what is it doing now"
 * are the same question asked of different files.
 */
export function LogsPanel() {
  const [list, setList] = useState<LogList | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [meta, setMeta] = useState<LogMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<ParsedCsv | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList(await api.listLogs())
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setMeta(null)
      return
    }
    let cancelled = false
    api
      .logMeta(selected)
      .then((response) => {
        if (!cancelled) {
          setMeta(response)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const openLocal = async (file: File | null) => {
    if (!file) return
    try {
      const parsed = parseCsv(await file.text(), file.name)
      setLocal(parsed)
      setSelected(null)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Stack gap="xl">
      {error ? (
        <Alert color="red" icon={<AlertTriangle size={18} />} title="Could not read the logs">
          {error}
        </Alert>
      ) : null}

      <Paper withBorder p="lg" radius="lg">
        <Section
          title="Saved logs"
          description={
            list ? (
              <>
                In <span className="tabular">{list.csv_dir}</span> —{" "}
                {list.writing
                  ? "the directory this service is writing into."
                  : "read-only; this service is not writing here."}
              </>
            ) : (
              "Reading the directory…"
            )
          }
          action={
            <Group gap="sm">
              <FileButton onChange={openLocal} accept=".csv,text/csv">
                {(props) => (
                  <Button
                    {...props}
                    variant="default"
                    size="compact-md"
                    leftSection={<FolderOpen size={15} />}
                  >
                    Open a file
                  </Button>
                )}
              </FileButton>
              <Button
                variant="default"
                size="compact-md"
                leftSection={<RefreshCw size={15} />}
                onClick={() => void refresh()}
              >
                Refresh
              </Button>
            </Group>
          }
        >
          {list && list.logs.length === 0 ? (
            <Text size="sm" c="dimmed">
              No CSV files here yet.
            </Text>
          ) : (
            <ScrollArea.Autosize mah={320}>
              <Table verticalSpacing="xs" highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>File</Table.Th>
                    <Table.Th>Device</Table.Th>
                    <Table.Th ta="right">Size</Table.Th>
                    <Table.Th>Last written</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list?.logs.map((entry) => (
                    <Table.Tr
                      key={entry.filename}
                      bg={selected === entry.filename ? "blue.0" : undefined}
                    >
                      <Table.Td className="tabular">{entry.filename}</Table.Td>
                      <Table.Td fw={500}>{entry.name}</Table.Td>
                      <Table.Td ta="right" className="tabular">
                        {formatBytes(entry.size)}
                      </Table.Td>
                      <Table.Td className="tabular" c="dimmed">
                        {formatStamp(entry.modified)}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button
                            size="compact-sm"
                            variant={selected === entry.filename ? "filled" : "default"}
                            onClick={() => {
                              setSelected(entry.filename)
                              setLocal(null)
                            }}
                          >
                            Plot
                          </Button>
                          <Anchor href={api.logDownloadUrl(entry.filename)} download>
                            <Download size={16} />
                          </Anchor>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </Section>
      </Paper>

      {selected && meta ? <SavedLogChart filename={selected} meta={meta} /> : null}
      {local ? <LocalLogChart parsed={local} /> : null}
    </Stack>
  )
}

/** A log on the server: windows are fetched, so the file is never read whole. */
function SavedLogChart({ filename, meta }: { filename: string; meta: LogMeta }) {
  const [unit, setUnit] = useState("")
  const [logY, setLogY] = useState((meta.measure ?? "pressure") === "pressure")
  const range = useTimeRange(meta.first_at)

  // Open on the whole file rather than on the last ten minutes of a log that
  // stopped being written a week ago.
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === filename) return
    if (meta.first_at == null || meta.last_at == null) return
    seeded.current = filename
    range.setWindow(meta.first_at, meta.last_at)
  }, [filename, meta.first_at, meta.last_at, range])

  // The unit applies to every channel of the file. Eight covers the widest
  // instrument here (the Lake Shore), and naming them all costs less than a
  // round trip to find out how many the file actually has.
  const units = useMemo<Record<number, string>>(
    () => (unit ? Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((index) => [index, unit])) : {}),
    [unit],
  )
  const fetcher = useCallback(
    (query: SeriesQuery) => api.logSeries(filename, query),
    [filename],
  )
  const { data, loading, error } = useSeries(fetcher, range.window, units, { follow: false })

  return (
    <Stack gap="lg">
      <Paper withBorder p="lg" radius="lg">
        <Section
          title={meta.name}
          description={filename}
          action={
            meta.imported_from ? (
              <Badge variant="light" color="gray">
                from an earlier install
              </Badge>
            ) : null
          }
        >
          <FactGrid>
            <Fact label="Format">{meta.format_label}</Fact>
            <Fact label="Columns" mono>
              {meta.header.join(", ")}
            </Fact>
            <Fact label="Covers">
              {meta.first_at && meta.last_at
                ? `${formatStamp(meta.first_at)} → ${formatStamp(meta.last_at)} (${formatDuration(meta.span_seconds ?? 0)})`
                : "no rows"}
            </Fact>
            <Fact label="Size">
              {formatBytes(meta.size)}, about {formatCount(meta.estimated_rows)} rows
            </Fact>
            <Fact label="Device">{meta.device_name || meta.device_type || "—"}</Fact>
            <Fact label="Copied in from" mono>
              {meta.imported_from}
            </Fact>
          </FactGrid>
        </Section>
      </Paper>

      <ChartCard
        channels={data?.series ?? []}
        range={range}
        loading={loading}
        error={error}
        availableUnits={unitsFor(data)}
        unit={unit}
        onUnitChange={setUnit}
        logY={logY}
        onLogYChange={setLogY}
        dataStart={meta.first_at}
        dataEnd={meta.last_at}
        exportName={meta.name}
        rowStride={data?.row_stride ?? 1}
        header={
          <Stack gap={0}>
            <Text fw={600} size="lg">
              {meta.name}
            </Text>
            <Text size="sm" c="dimmed">
              from the file · not live
            </Text>
          </Stack>
        }
      />
    </Stack>
  )
}

/** A file the operator opened from their own machine; parsed in the browser. */
function LocalLogChart({ parsed }: { parsed: ParsedCsv }) {
  const [logY, setLogY] = useState(parsed.measure === "pressure")
  const start = parsed.channels[0]?.t[0] ?? null
  const end = parsed.channels[0]?.t.at(-1) ?? null
  const range = useTimeRange(start)

  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === parsed.name) return
    if (start == null || end == null) return
    seeded.current = parsed.name
    range.setWindow(start, end)
  }, [parsed.name, start, end, range])

  const channels = useMemo(
    () => sliceChannels(parsed.channels, range.window.from, range.window.to, 2000),
    [parsed.channels, range.window],
  )

  return (
    <Stack gap="lg">
      <Paper withBorder p="lg" radius="lg">
        <Section
          title={parsed.name}
          description="Opened from your machine and parsed in the browser — nothing was uploaded."
          action={<Badge variant="light">local file</Badge>}
        >
          <FactGrid>
            <Fact label="Format">
              {parsed.format === "cmms"
                ? "cmms-web / original CMMS"
                : parsed.format === "vacuum_monitoring"
                  ? "written by this service"
                  : "unrecognised header"}
            </Fact>
            <Fact label="Rows">{formatCount(parsed.rows)}</Fact>
            <Fact label="Channels">
              {parsed.channels.map((channel) => `${channel.label} (${channel.unit})`).join(", ")}
            </Fact>
            <Fact label="Covers">
              {start && end
                ? `${formatStamp(start)} → ${formatStamp(end)} (${formatDuration(end - start)})`
                : "no rows"}
            </Fact>
          </FactGrid>
        </Section>
      </Paper>

      <ChartCard
        channels={channels}
        range={range}
        loading={false}
        error={null}
        // Converting a local file would mean re-deriving units the browser
        // never read from an instrument; it is shown as recorded.
        availableUnits={parsed.channels[0] ? [parsed.channels[0].unit] : []}
        unit={parsed.channels[0]?.unit ?? ""}
        onUnitChange={() => undefined}
        logY={logY}
        onLogYChange={setLogY}
        dataStart={start}
        dataEnd={end}
        exportName={parsed.name}
        header={
          <Stack gap={0}>
            <Text fw={600} size="lg">
              {parsed.name}
            </Text>
            <Text size="sm" c="dimmed">
              from your machine · as recorded
            </Text>
          </Stack>
        }
      />
    </Stack>
  )
}

const PRESSURE_UNITS = ["Torr", "mbar", "Pa", "hPa", "Micron", "atm", "psi"]
const TEMPERATURE_UNITS = ["K", "degC", "degF"]

function unitsFor(data: SeriesResponse | null): string[] {
  return data?.measure === "temperature" ? TEMPERATURE_UNITS : PRESSURE_UNITS
}
