import { useCallback, useEffect, useState } from "react"
import { Brand, Choice, Screen, Spacer, StateDot, Tabs, Tag, ThemeSwitch, type TabItem, type Tone } from "@neon"

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
import type { DeviceSnapshot, Me, SourceConfig } from "@/lib/types"

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

/** Remembered per browser: a controller who chose to just watch stays watching. */
const MODE_KEY = "vacuum.mode"
type Mode = "control" | "monitor"
/** A portal role change reaches the page within this. */
const ME_INTERVAL = 30000

/**
 * One service, two modes. Control opens, closes and configures gauges (the
 * Sources tab); monitoring only watches. Who may control is the server's call
 * (/api/me, enforced on every write); anyone who may can step down to Monitor.
 */
export default function App() {
  const { devices, live, mode } = useStatusStream()
  const [me, setMe] = useState<Me | null>(null)
  const [chosen, setChosen] = useState<Mode>(() => {
    try {
      return window.localStorage.getItem(MODE_KEY) === "monitor" ? "monitor" : "control"
    } catch {
      return "control"
    }
  })
  const mayControl = me?.control ?? false
  const control = mayControl && chosen === "control"
  useEffect(() => {
    const ask = () => api.me().then(setMe).catch(() => undefined)
    ask()
    const timer = setInterval(ask, ME_INTERVAL)
    return () => clearInterval(timer)
  }, [])
  const chooseMode = (next: Mode) => {
    setChosen(next)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      /* it just will not be remembered */
    }
  }
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
    // Saved with the profile only by someone who may change it; a watcher's
    // choice stays in this page.
    if (device.profile_id && control) {
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
    ((control && requestedTab === SOURCES_TAB) ||
      requestedTab === LOGS_TAB ||
      requestedTab === REFERENCE_TAB ||
      ids.includes(requestedTab))
      ? requestedTab
      : (ids[0] ?? (control ? SOURCES_TAB : LOGS_TAB))

  const closeDevice = (device: DeviceSnapshot) =>
    void run(
      `close:${device.id}`,
      async () => {
        await api.removeDevice(device.id)
        refreshConfig()
      },
      `Closed ${device.name}`,
    )

  const tabs: TabItem[] = [
    ...(control ? [{
      value: SOURCES_TAB,
      label: "Sources",
    }] : []),
    ...devices.map((device) => ({
      value: device.id,
      label: device.name,
      // The reading itself under the name: from across the room the tab row is the panel.
      state: deviceSummary(device),
      tone: deviceTone(device),
    })),
    { value: LOGS_TAB, label: "Logs" },
    { value: REFERENCE_TAB, label: "Reference" },
  ]

  return (
    <Screen
      top={
        <>
          {/* Monitoring is stated, not implied by missing buttons. */}
          <Brand name="Vacuum" readOnly={!control} />
          <Tabs items={tabs} value={active} onChange={setRequestedTab} />
          <Spacer />
          {/* What the readings come from is a fact, not a reading (NEON rule 4). */}
          {config ? <Tag label="MODE">{config.mode === "live" ? "instruments" : "saved logs"}</Tag> : null}
          {/* The socket: a page that stopped updating must say so (rule 5: one width). */}
          <StateDot tone={live ? "ok" : "warn"} reserve={["live", "reconnecting"]}>
            {live ? "live" : "reconnecting"}
          </StateDot>
          {mayControl ? (
            <Choice
              small
              options={[
                { value: "control", label: "Control" },
                { value: "monitor", label: "Monitor" },
              ]}
              value={control ? "control" : "monitor"}
              onChange={chooseMode}
            />
          ) : null}
          <ThemeSwitch />
        </>
      }
    >
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
              onClose={control ? () => closeDevice(device) : undefined}
              closing={pending === `close:${device.id}`}
            />
          ))
      )}
    </Screen>
  )
}

/** Lit when a gauge is being read; dim for saved logs or a closed device; pink on an error. */
function deviceTone(device: DeviceSnapshot): Tone {
  if (device.status === "error" || device.last_error) return "alarm"
  // A tab of saved logs is dim however healthy it is: nothing about it is live.
  if (device.source === "file") return "idle"
  if (device.status === "closed") return "idle"
  return "ok"
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
