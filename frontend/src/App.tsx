import { useCallback, useEffect, useState } from "react"
import { AppShell, Badge, Container, Group, Stack, Tabs, Text, Title } from "@mantine/core"
import { BookOpen, Database, FolderClock } from "lucide-react"

import type { WatermarkAt } from "@/components/chart/watermark-plugin"
import { DevicePanel } from "@/components/device-panel"
import { LogsPanel } from "@/components/logs-panel"
import { ReferencePanel } from "@/components/reference-panel"
import { SourcesPanel } from "@/components/sources-panel"
import { useAction } from "@/hooks/use-action"
import { useStatusStream } from "@/hooks/use-status-stream"
import { api } from "@/lib/api"
import { formatValue, unitLabel } from "@/lib/format"
import { formatDuration } from "@/lib/time"
import type { DeviceSnapshot, SourceConfig } from "@/lib/types"

/** How one device's chart is being read, per device. */
interface DeviceView {
  unit: string
  /** null / undefined means "decide from what is being measured". */
  logY: boolean | null
  watermarkAt: WatermarkAt
}

/** The three tabs that are always there, whatever is open. */
const SOURCES_TAB = "sources"
const LOGS_TAB = "logs"
const REFERENCE_TAB = "reference"

export default function App() {
  const { devices, live, mode } = useStatusStream()
  const [config, setConfig] = useState<SourceConfig | null>(null)
  const { pending, run } = useAction()

  const [requestedTab, setRequestedTab] = useState<string | null>(null)
  // How each device is being read. Kept here because a device panel unmounts
  // every time you look at another tab, and a unit that silently reverts when
  // you come back is worse than no unit selector at all. Where the device came
  // from a profile it is also written back to it, so it survives a restart and
  // is the same from another browser.
  const [views, setViews] = useState<Record<string, DeviceView>>({})

  useEffect(() => {
    // Seed from the profiles, once each, without clobbering a live choice.
    void api
      .listProfiles()
      .then((profiles) => {
        setViews((current) => {
          const next = { ...current }
          for (const profile of profiles) {
            for (const deviceId of profile.device_ids) {
              if (next[deviceId]) continue
              next[deviceId] = {
                unit: profile.display_unit,
                logY: profile.log_y,
                watermarkAt: profile.watermark_at,
              }
            }
          }
          return next
        })
      })
      .catch(() => undefined)
  }, [devices.length])

  const setView = (device: DeviceSnapshot, patch: Partial<DeviceView>) => {
    setViews((current) => ({ ...current, [device.id]: { ...current[device.id], ...patch } }))
    if (device.profile_id) {
      void api
        .saveProfileView(device.profile_id, {
          display_unit: patch.unit,
          log_y: patch.logY,
          watermark_at: patch.watermarkAt,
        })
        .catch(() => undefined)
    }
  }

  /** Log axis when nothing has been chosen: pressure spans decades. */
  const logFor = (device: DeviceSnapshot) =>
    views[device.id]?.logY ?? device.measure === "pressure"

  const refreshConfig = useCallback(() => {
    void api
      .readSource()
      .then(setConfig)
      .catch(() => undefined)
  }, [])

  useEffect(refreshConfig, [refreshConfig])
  // The mode can change from another browser, or from the command line.
  useEffect(() => {
    if (mode && config && mode !== config.mode) refreshConfig()
  }, [mode, config, refreshConfig])

  const ids = devices.map((device) => device.id)
  const active =
    requestedTab &&
    (requestedTab === SOURCES_TAB ||
      requestedTab === LOGS_TAB ||
      requestedTab === REFERENCE_TAB ||
      ids.includes(requestedTab))
      ? requestedTab
      : (ids[0] ?? SOURCES_TAB)

  const closeDevice = (device: DeviceSnapshot) =>
    void run(
      `close:${device.id}`,
      async () => {
        await api.removeDevice(device.id)
        refreshConfig()
      },
      `Closed ${device.name}`,
    )

  return (
    <AppShell header={{ height: { base: 104, md: 132 } }} padding={0}>
      {/* The header is fixed, so the tabs stay reachable however far you
          scroll. No bottom rule: the tabs are coloured blocks and separate
          themselves. */}
      <AppShell.Header withBorder={false}>
        <Container h={64}>
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
              <Title order={1} fz="h3" fw={600} className="app-title">
                Vacuum Monitoring
              </Title>
              <Badge size="md" radius="sm" variant="light" color={live ? "teal" : "red"}>
                {live ? "Live" : "Reconnecting"}
              </Badge>
              {config ? (
                <Badge size="md" radius="sm" variant="default" visibleFrom="sm">
                  {config.mode === "live" ? "reading the instruments" : "reading saved logs"}
                </Badge>
              ) : null}
            </Group>

          </Group>
        </Container>

        <Container>
          <Tabs value={active} onChange={setRequestedTab} variant="pills">
            <Tabs.List>
              <StateTab
                value={SOURCES_TAB}
                active={active === SOURCES_TAB}
                tone="blue"
                name="Sources"
                icon={<Database size={16} />}
                state={
                  devices.length > 0
                    ? `${devices.length} device${devices.length === 1 ? "" : "s"}`
                    : "nothing open"
                }
              />

              {devices.map((device) => (
                <StateTab
                  key={device.id}
                  value={device.id}
                  active={active === device.id}
                  tone={deviceTone(device)}
                  name={device.name}
                  /* The reading itself under the name: from across the room
                     the tab row is the panel. */
                  state={deviceSummary(device)}
                />
              ))}

              <StateTab
                value={LOGS_TAB}
                active={active === LOGS_TAB}
                tone="gray"
                name="Logs"
                icon={<FolderClock size={16} />}
                state="saved CSVs"
                style={{ marginInlineStart: "auto" }}
              />

              {/* Reference, not a device: an icon alone at the far end, so it
                  never competes with the tabs you switch between. */}
              <Tabs.Tab
                value={REFERENCE_TAB}
                className="state-tab icon-tab"
                aria-label="Reference — what each instrument measures and how"
                style={toneVars("gray", active === REFERENCE_TAB)}
              >
                <BookOpen size={20} />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
        </Container>
      </AppShell.Header>

      <AppShell.Main>
        <Container py="xl">
          {active === REFERENCE_TAB ? (
            <ReferencePanel />
          ) : active === LOGS_TAB ? (
            <LogsPanel />
          ) : active === SOURCES_TAB ? (
            <SourcesPanel config={config} devices={devices} onChanged={refreshConfig} />
          ) : (
            devices
              .filter((device) => device.id === active)
              .map((device) => (
                <DevicePanel
                  key={device.id}
                  device={device}
                  unit={views[device.id]?.unit ?? ""}
                  onUnitChange={(unit) => setView(device, { unit })}
                  logY={logFor(device)}
                  onLogYChange={(logY) => setView(device, { logY })}
                  watermarkAt={views[device.id]?.watermarkAt ?? "center"}
                  onWatermarkAtChange={(watermarkAt) => setView(device, { watermarkAt })}
                  onClose={() => closeDevice(device)}
                  closing={pending === `close:${device.id}`}
                />
              ))
          )}
        </Container>
      </AppShell.Main>
    </AppShell>
  )
}

type Tone = "blue" | "teal" | "gray" | "red"

function deviceTone(device: DeviceSnapshot): Tone {
  if (device.status === "error" || device.last_error) return "red"
  // A tab of saved logs is grey however healthy it is: nothing about it is
  // live, and green across the row should mean gauges are being read.
  if (device.source === "file") return "gray"
  if (device.status === "closed") return "gray"
  return "teal"
}

/** The current reading, short enough to sit under the name on a tab. */
function deviceSummary(device: DeviceSnapshot): string {
  const first = device.channels[0]
  if (!first) return device.status
  if (device.source === "file") {
    return first.first_at && first.last_at
      ? `${formatDuration(first.last_at - first.first_at)} of logs`
      : "saved logs"
  }
  if (first.value == null) return device.status
  const more = device.channels.length > 1 ? ` +${device.channels.length - 1}` : ""
  return `${formatValue(first.value, 3)} ${unitLabel(first.unit)}${more}`
}

function toneVars(tone: Tone, active: boolean): React.CSSProperties {
  return {
    "--tt-bg": `var(--mantine-color-${tone}-${active ? 7 : 0})`,
    "--tt-fg": active ? "var(--mantine-color-white)" : `var(--mantine-color-${tone}-9)`,
    "--tt-bd": `var(--mantine-color-${tone}-${active ? 7 : 2})`,
    "--tt-hover": `var(--mantine-color-${tone}-${active ? 8 : 1})`,
  } as React.CSSProperties
}

/**
 * One tab: the name on top, what it is reading underneath, tinted by state.
 *
 * The colour is the point -- from across the room the tab row says which
 * gauges are alive before any of the words are readable.
 */
function StateTab({
  value,
  active,
  tone,
  name,
  state,
  icon,
  style,
}: {
  value: string
  active: boolean
  tone: Tone
  name: string
  state: string
  icon?: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <Tabs.Tab
      value={value}
      className="state-tab"
      fz="sm"
      py={6}
      leftSection={icon}
      style={{ ...toneVars(tone, active), ...style }}
    >
      <Stack gap={0} align="flex-start">
        <Text fw={500} className="tab-name">
          {name}
        </Text>
        <Text size="xs" fw={400} className="tab-meta tab-state tabular">
          {state}
        </Text>
      </Stack>
    </Tabs.Tab>
  )
}
