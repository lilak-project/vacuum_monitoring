import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge, Button, Checkbox, Collapse, Group, Paper, Radio, ScrollArea,
  Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Tooltip,
} from "@mantine/core"
import {
  History, Link2Off, Plus, RefreshCw, Server, Sparkles, Trash2, Usb,
} from "lucide-react"
import { Choice, NoticeLine } from "@neon"

import { Fact, FactGrid, Section } from "@/components/section"
import { useAction } from "@/hooks/use-action"
import { api } from "@/lib/api"
import { formatBytes, formatValue, unitLabel } from "@/lib/format"
import { formatDuration, formatStamp } from "@/lib/time"
import type {
  DeviceSnapshot, DeviceSpec, LogEntry, Profile, ProfileKind, SerialPort, SourceConfig,
} from "@/lib/types"

/**
 * Where the readings come from, and what is connected.
 *
 * One list, not three. An instrument on a port and another host's service are
 * different things to the program and the same thing to the operator -- a name
 * you press Connect on -- so they share a list and it carries whether each one
 * is live right now. The alternative, which this replaces, had the same gauge
 * appearing in "open devices" and again in "remembered devices" with no way to
 * tell that they were one thing.
 */
export function SourcesPanel({
  config,
  devices,
  onChanged,
}: {
  config: SourceConfig | null
  devices: DeviceSnapshot[]
  onChanged: () => void
}) {
  const { pending, run } = useAction()

  if (!config) {
    return <Text c="dimmed">Reading the service configuration…</Text>
  }

  return (
    <Stack gap="xl">
      <Paper withBorder p="lg" radius="lg">
        <Section
          title="Source"
          description="Switching closes whatever is open now — live instruments and saved logs do not mix."
        >
          <Radio.Group
            value={config.mode}
            onChange={(value) =>
              void run(
                "source",
                async () => {
                  await api.setSource(value)
                  onChanged()
                },
                value === "live" ? "Reading the instruments" : "Reading the saved logs",
              )
            }
          >
            <Stack gap="sm">
              {config.modes.map((item) => (
                <Radio
                  key={item.id}
                  value={item.id}
                  disabled={!item.available || pending === "source"}
                  label={
                    <div>
                      <Text fw={500}>{item.label}</Text>
                      <Text size="sm" c="dimmed">
                        {item.available ? item.detail : item.unavailable_reason}
                      </Text>
                    </div>
                  }
                />
              ))}
            </Stack>
          </Radio.Group>
        </Section>
      </Paper>

      {config.mode === "live" ? (
        <LiveSources config={config} devices={devices} onChanged={onChanged} />
      ) : (
        <AttachSources devices={devices} onChanged={onChanged} />
      )}

      <ServiceInfo config={config} />
    </Stack>
  )
}

/* ── live: profiles ─────────────────────────────────────────────────── */

function LiveSources({
  config,
  devices,
  onChanged,
}: {
  config: SourceConfig
  devices: DeviceSnapshot[]
  onChanged: () => void
}) {
  const { pending, run } = useAction()
  const [profiles, setProfiles] = useState<Profile[]>([])

  const refresh = useCallback(async () => {
    setProfiles(await api.listProfiles())
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh, devices.length])

  return (
    <Stack gap="xl">
      <Paper withBorder p="lg" radius="lg">
        <Section
          title="Profiles"
          description="Everything this service knows how to connect to. Connecting opens the instrument, or starts mirroring the other host."
          action={
            <Button
              variant="default"
              size="compact-md"
              leftSection={<RefreshCw size={15} />}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          }
        >
          {profiles.length === 0 ? (
            <Text size="sm" c="dimmed">
              None yet. Add one below.
            </Text>
          ) : (
            <Stack gap="sm">
              {profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  devices={devices.filter((device) => profile.device_ids.includes(device.id))}
                  pending={pending}
                  onConnect={(keepHistory) =>
                    void run(
                      `connect:${profile.id}`,
                      async () => {
                        await api.connectProfile(profile.id, keepHistory)
                        await refresh()
                        onChanged()
                      },
                      keepHistory
                        ? `Connected ${profile.name}, continuing from its earlier logs`
                        : `Connected ${profile.name}, starting fresh`,
                    )
                  }
                  onDisconnect={() =>
                    void run(
                      `connect:${profile.id}`,
                      async () => {
                        await api.disconnectProfile(profile.id)
                        await refresh()
                        onChanged()
                      },
                      `Disconnected ${profile.name}`,
                    )
                  }
                  onForget={() =>
                    void run(`forget:${profile.id}`, async () => {
                      setProfiles(await api.deleteProfile(profile.id))
                      onChanged()
                    })
                  }
                  onAutostart={(on) =>
                    void run(`auto:${profile.id}`, async () => {
                      setProfiles(await api.saveProfile({ ...profile, autostart: on }))
                    })
                  }
                  onHistory={(filenames) =>
                    void run(
                      `history:${profile.id}`,
                      async () => {
                        setProfiles(await api.setProfileHistory(profile.id, filenames))
                      },
                      "Earlier logs saved — reconnect to draw them",
                    )
                  }
                />
              ))}
            </Stack>
          )}
        </Section>
      </Paper>

      <AddProfile config={config} onAdded={refresh} />
    </Stack>
  )
}

/** One profile: what it is, whether it is live, and the one button that matters. */
function ProfileRow({
  profile,
  devices,
  pending,
  onConnect,
  onDisconnect,
  onForget,
  onAutostart,
  onHistory,
}: {
  profile: Profile
  devices: DeviceSnapshot[]
  pending: string | null
  onConnect: (keepHistory: boolean) => void
  onDisconnect: () => void
  onForget: () => void
  onAutostart: (on: boolean) => void
  onHistory: (filenames: string[]) => void
}) {
  const [pickingHistory, setPickingHistory] = useState(false)
  const busy = pending === `connect:${profile.id}`
  const failed = devices.some((device) => device.status === "error") || profile.last_error
  const tone = failed ? "red" : profile.connected ? "teal" : "gray"

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {/* A dot, because from a metre away the colour is the state. */}
          <div
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              flex: "none",
              background: `var(--mantine-color-${tone}-6)`,
            }}
          />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600}>{profile.name}</Text>
              <Badge size="sm" variant="light" color={profile.kind === "remote" ? "grape" : "blue"}>
                {profile.kind === "remote" ? "remote host" : profile.device_type}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed" className="tabular">
              {profile.kind === "remote" ? profile.url : profile.port || "no port"}
            </Text>
            <ProfileState profile={profile} devices={devices} />
          </Stack>
        </Group>

        <Group gap="xs" justify="flex-end" miw={300}>
          <Tooltip label="Reconnect this automatically when the service starts">
            <div>
              <Switch
                size="sm"
                label="Auto"
                checked={profile.autostart}
                onChange={(event) => onAutostart(event.currentTarget.checked)}
              />
            </div>
          </Tooltip>
          {profile.connected ? (
            <Button
              variant="default"
              leftSection={<Link2Off size={16} />}
              loading={busy}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          ) : (
            /* Two ways to start, because they are different experiments. */
            <Button.Group>
              <Tooltip
                label={
                  profile.log_files.length
                    ? `Draw this run on top of its ${profile.log_files.length} earlier log${
                        profile.log_files.length === 1 ? "" : "s"
                      }`
                    : "Nothing recorded yet — this will start a first run"
                }
              >
                <Button
                  variant="filled"
                  leftSection={<History size={16} />}
                  loading={busy}
                  onClick={() => onConnect(true)}
                >
                  Continue
                </Button>
              </Tooltip>
              <Tooltip label="Start a clean chart — the earlier logs stay on disk, just off the chart">
                <Button
                  variant="default"
                  leftSection={<Sparkles size={15} />}
                  disabled={busy}
                  onClick={() => onConnect(false)}
                >
                  New
                </Button>
              </Tooltip>
            </Button.Group>
          )}
          {profile.kind === "serial" ? (
            <Tooltip label="Choose which earlier logs this profile continues from">
              <Button
                variant="subtle"
                color="gray"
                px={10}
                onClick={() => setPickingHistory((open) => !open)}
                aria-label={`Earlier logs for ${profile.name}`}
              >
                <History size={16} />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip label="Forget this profile">
            <Button
              variant="subtle"
              color="gray"
              px={10}
              disabled={busy}
              onClick={onForget}
              aria-label={`Forget ${profile.name}`}
            >
              <Trash2 size={16} />
            </Button>
          </Tooltip>
        </Group>
      </Group>

      <Collapse expanded={pickingHistory}>
        <HistoryPicker
          profile={profile}
          busy={pending === `history:${profile.id}`}
          onSave={(filenames) => {
            onHistory(filenames)
            setPickingHistory(false)
          }}
        />
      </Collapse>
    </Paper>
  )
}

/**
 * Which logs count as this profile's past.
 *
 * The gauge on this chamber was logged by an earlier program before this
 * service existed, and those files are the beginning of the same line. Nothing
 * in a filename says so, though -- only the person who was there knows which
 * runs belong to which chamber -- so it is a choice rather than a guess.
 */
function HistoryPicker({
  profile,
  busy,
  onSave,
}: {
  profile: Profile
  busy: boolean
  onSave: (filenames: string[]) => void
}) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [chosen, setChosen] = useState<string[]>(profile.log_files)

  useEffect(() => {
    void api
      .listLogs()
      .then((list) => setLogs(list.logs))
      .catch(() => undefined)
  }, [])

  useEffect(() => setChosen(profile.log_files), [profile.log_files])

  const toggle = (filename: string) =>
    setChosen((current) =>
      current.includes(filename)
        ? current.filter((item) => item !== filename)
        : [...current, filename],
    )

  return (
    <Stack gap="sm" pt="md" mt="md" style={{ borderTop: "1px solid var(--mantine-color-gray-2)" }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          Ticked logs are drawn behind this gauge's live trace when you press Continue.
          {profile.connected ? " Reconnect for a change to take effect." : ""}
        </Text>
        <Group gap="xs">
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={() => setChosen(logs.map((entry) => entry.filename))}
          >
            All {logs.length}
          </Button>
          <Button size="compact-sm" variant="subtle" color="gray" onClick={() => setChosen([])}>
            None
          </Button>
          <Button size="compact-sm" loading={busy} onClick={() => onSave(chosen)}>
            Save ({chosen.length})
          </Button>
        </Group>
      </Group>

      <ScrollArea.Autosize mah={280}>
        <Stack gap={2}>
          {logs.map((entry) => (
            <Checkbox
              key={entry.filename}
              size="sm"
              checked={chosen.includes(entry.filename)}
              onChange={() => toggle(entry.filename)}
              label={
                <Group gap="sm" wrap="nowrap">
                  <Text size="sm" className="tabular">
                    {entry.filename}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(entry.size)} · {formatStamp(entry.modified)}
                  </Text>
                </Group>
              }
            />
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  )
}

/** What a connected profile is actually reading, right now. */
function ProfileState({ profile, devices }: { profile: Profile; devices: DeviceSnapshot[] }) {
  if (profile.last_error) {
    return (
      <Text size="sm" c="red">
        {profile.last_error}
      </Text>
    )
  }
  if (!profile.connected) {
    return (
      <Text size="sm" c="dimmed">
        not connected
        {profile.log_files.length > 0
          ? ` · ${profile.log_files.length} earlier log${profile.log_files.length === 1 ? "" : "s"} to continue from`
          : ""}
      </Text>
    )
  }
  const failed = devices.find((device) => device.last_error)
  if (failed) {
    return (
      <Text size="sm" c="red">
        {failed.last_error}
      </Text>
    )
  }
  const readings = devices.flatMap((device) =>
    device.channels
      .filter((channel) => channel.value != null)
      .map((channel) => `${formatValue(channel.value, 3)} ${unitLabel(channel.unit)}`),
  )
  const rows = devices.reduce((sum, device) => sum + device.log_rows, 0)
  return (
    <Text size="sm" c="teal" className="tabular">
      connected
      {profile.continued ? " · continuing" : ""}
      {readings.length > 0 ? ` · ${readings.slice(0, 3).join(", ")}` : ""}
      {rows > 0 ? ` · ${rows.toLocaleString("en-US")} rows this run` : ""}
    </Text>
  )
}

/** Adding an instrument or another host.  Saving does not connect it. */
function AddProfile({ config, onAdded }: { config: SourceConfig; onAdded: () => void }) {
  const { pending, run } = useAction()
  const [kind, setKind] = useState<ProfileKind>("serial")
  const [ports, setPorts] = useState<SerialPort[]>([])
  const [types, setTypes] = useState<DeviceSpec[]>([])
  const [showAllPorts, setShowAllPorts] = useState(false)
  const [deviceType, setDeviceType] = useState<string | null>(null)
  const [port, setPort] = useState<string | null>(null)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")

  const rescan = useCallback(async () => {
    const [portList, typeList] = await Promise.all([api.listPorts(), api.listDeviceTypes()])
    setPorts(portList)
    setTypes(typeList)
  }, [])

  useEffect(() => {
    void rescan().catch(() => undefined)
  }, [rescan])

  // This machine reports 32 built-in serial lines with nothing on them. An
  // instrument is on a USB adapter and has a hardware id, so those lead and the
  // rest are behind a switch.
  const visiblePorts = useMemo(
    () => (showAllPorts ? ports : ports.filter((item) => item.physical)),
    [ports, showAllPorts],
  )
  const busyPorts = useMemo(() => ports.filter((item) => item.held_by.length > 0), [ports])
  const selectedPort = ports.find((item) => item.device === port)

  const add = () =>
    void run(
      "add",
      async () => {
        await api.saveProfile(
          kind === "remote"
            ? { kind, url, name }
            : { kind, device_type: deviceType ?? "", port: port ?? "", name },
        )
        setName("")
        setUrl("")
        onAdded()
      },
      "Added to profiles",
    )

  const ready = kind === "remote" ? url.trim().length > 0 : Boolean(deviceType)

  return (
    <Paper withBorder p="lg" radius="lg">
      <Section
        title="Add a device"
        description="Added to the list above, not connected. Press Connect when you want it live."
        action={
          kind === "serial" ? (
            <Group gap="sm">
              <Switch
                size="sm"
                label="All ports"
                checked={showAllPorts}
                onChange={(event) => setShowAllPorts(event.currentTarget.checked)}
              />
              <Button
                variant="default"
                size="compact-md"
                leftSection={<RefreshCw size={15} />}
                onClick={() => void rescan()}
              >
                Rescan
              </Button>
            </Group>
          ) : null
        }
      >
        <div>
          <Choice
            value={kind}
            onChange={setKind}
            options={[
              { value: "serial" as ProfileKind, label: <><Usb size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />Instrument on this machine</> },
              { value: "remote" as ProfileKind, label: <><Server size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />Another host</> },
            ]}
          />
        </div>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
          {kind === "serial" ? (
            <>
              <Select
                label="Port"
                placeholder={visiblePorts.length ? "Choose a port" : "No USB serial adapters found"}
                value={port}
                onChange={(value) => {
                  setPort(value)
                  // The USB id usually says what is on the other end; offering
                  // it saves remembering which box is on which cable.
                  const suggestion = ports.find((item) => item.device === value)?.suggested_types[0]
                  if (suggestion && !deviceType) setDeviceType(suggestion)
                }}
                data={visiblePorts.map((item) => ({
                  value: item.device,
                  label: item.held_by.length
                    ? `${item.device} — in use by ${item.held_by[0].name}`
                    : `${item.device} — ${item.description}`,
                }))}
                searchable
                comboboxProps={{ withinPortal: true }}
              />
              <Select
                label="Instrument"
                placeholder="Choose a type"
                value={deviceType}
                onChange={setDeviceType}
                data={types.map((item) => ({
                  value: item.name,
                  label: item.simulated ? `${item.name} — simulated` : item.name,
                }))}
                comboboxProps={{ withinPortal: true }}
              />
            </>
          ) : (
            <TextInput
              label="Address"
              placeholder={config.default_remote_url}
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              styles={{ root: { gridColumn: "span 2" } }}
            />
          )}
          <TextInput
            label="Name"
            placeholder={kind === "remote" ? "lab PC" : (deviceType ?? "Chamber gauge")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            mt={{ base: 0, sm: 26 }}
            leftSection={<Plus size={17} />}
            disabled={!ready}
            loading={pending === "add"}
            onClick={add}
          >
            Add profile
          </Button>
        </SimpleGrid>

        {kind === "serial" && selectedPort && selectedPort.suggested_types.length > 0 ? (
          <Text size="sm" c="dimmed">
            {selectedPort.hwid} — that USB id belongs to {selectedPort.suggested_types.join(", ")}.
            {selectedPort.suggested_types.length > 1
              ? " Several instruments here share one adapter chip, so the port is the only way to tell them apart."
              : ""}
          </Text>
        ) : null}

        {/* Two programs on one tty is not an error Linux reports: they split
            the bytes between them and both lose readings. */}
        {kind === "serial" ? (
          // Always there for a serial source (rule 5): a port another program
          // holds fills this line instead of a box appearing above the form.
          <NoticeLine
            tone={busyPorts.length > 0 ? "warn" : null}
            more={
              busyPorts.length > 0 ? (
                <>
                  {busyPorts.map((item) => (
                    <div key={item.device}>
                      <span className="tabular">{item.device}</span> is held by{" "}
                      {item.held_by.map((holder) => `${holder.name} (pid ${holder.pid})`).join(", ")}.
                    </div>
                  ))}
                  <div className="faint">
                    Only one program can read a gauge — the other would get half the bytes and neither
                    would be right. Stop it before connecting here.
                  </div>
                </>
              ) : undefined
            }
          >
            {busyPorts.length > 0
              ? `Ports already in use: ${busyPorts.map((item) => item.device).join(", ")}`
              : "No serial port is held by another program"}
          </NoticeLine>
        ) : null}
      </Section>
    </Paper>
  )
}

/* ── attach: file sets ──────────────────────────────────────────────── */

/**
 * Pick logs and open them as a tab.
 *
 * Several at once, on purpose: a gauge's history is spread over a file per run,
 * and the question is almost never "what did this one file say" but "what has
 * the pressure been doing". Selected files are drawn as one line in time order.
 */
function AttachSources({
  devices,
  onChanged,
}: {
  devices: DeviceSnapshot[]
  onChanged: () => void
}) {
  const { pending, run } = useAction()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLogs((await api.listLogs()).logs)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = devices.filter((device) => device.source === "file")
  const all = logs.map((entry) => entry.filename)
  const allChosen = chosen.length > 0 && chosen.length === all.length

  return (
    <Stack gap="xl">
      {open.length > 0 ? (
        <Paper withBorder p="lg" radius="lg">
          <Section title="Open tabs" description="Each is one or more logs drawn as a single trace.">
            <Stack gap="xs">
              {open.map((device) => (
                <Group key={device.id} justify="space-between">
                  <Text fw={500}>
                    {device.name}{" "}
                    <Text span c="dimmed" size="sm">
                      · {device.channels.length} channel
                      {device.channels.length === 1 ? "" : "s"}
                    </Text>
                  </Text>
                  <Button
                    size="compact-sm"
                    variant="default"
                    leftSection={<Trash2 size={14} />}
                    loading={pending === `close:${device.id}`}
                    onClick={() =>
                      void run(`close:${device.id}`, async () => {
                        await api.removeDevice(device.id)
                        onChanged()
                      })
                    }
                  >
                    Close
                  </Button>
                </Group>
              ))}
            </Stack>
          </Section>
        </Paper>
      ) : null}

      <Paper withBorder p="lg" radius="lg">
        <Section
          title="Saved logs"
          description="Tick the runs you want and press Add. Several become one continuous trace, joined in time order."
          action={
            <Group gap="sm">
              <Button
                variant="subtle"
                size="compact-md"
                color="gray"
                onClick={() => setChosen(allChosen ? [] : all)}
              >
                {allChosen ? "Clear" : "Select all"}
              </Button>
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
          {/* A failed read or add fills this line in place (rule 5). */}
          <NoticeLine tone={error ? "alarm" : null}>{error || "Saved logs read"}</NoticeLine>

          <Group gap="md" align="flex-end">
            <TextInput
              label="Tab name"
              placeholder="the newest file's device"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              w={260}
            />
            <Button
              leftSection={<Plus size={17} />}
              disabled={chosen.length === 0}
              loading={pending === "attach"}
              onClick={() =>
                void run(
                  "attach",
                  async () => {
                    // Oldest first, so the tab reads left to right.
                    const ordered = all.filter((filename) => chosen.includes(filename)).reverse()
                    await api.attachFiles(ordered, name)
                    setChosen([])
                    setName("")
                    onChanged()
                  },
                  `Opened ${chosen.length} file${chosen.length === 1 ? "" : "s"}`,
                )
              }
            >
              Add {chosen.length > 0 ? `(${chosen.length})` : ""}
            </Button>
          </Group>

          {/* The whole list, not a scroller: it is the record, and how much of
              it there is is part of what you want to see. */}
          <Table verticalSpacing={6} highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40} />
                <Table.Th>File</Table.Th>
                <Table.Th>Device</Table.Th>
                <Table.Th ta="right">Size</Table.Th>
                <Table.Th>Last written</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.map((entry) => (
                <Table.Tr
                  key={entry.filename}
                  onClick={() =>
                    setChosen((current) =>
                      current.includes(entry.filename)
                        ? current.filter((item) => item !== entry.filename)
                        : [...current, entry.filename],
                    )
                  }
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td>
                    <Checkbox
                      aria-label={entry.filename}
                      checked={chosen.includes(entry.filename)}
                      onChange={() => undefined}
                    />
                  </Table.Td>
                  <Table.Td className="tabular">{entry.filename}</Table.Td>
                  <Table.Td fw={500}>{entry.name}</Table.Td>
                  <Table.Td ta="right" className="tabular">
                    {formatBytes(entry.size)}
                  </Table.Td>
                  <Table.Td className="tabular" c="dimmed">
                    {formatStamp(entry.modified)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {logs.length === 0 ? (
            <Text size="sm" c="dimmed">
              No logs in that directory yet.
            </Text>
          ) : null}
        </Section>
      </Paper>
    </Stack>
  )
}

/* ── the service itself ─────────────────────────────────────────────── */

/**
 * Where the files are and how fast it reads.
 *
 * At the bottom because it is reference, not a control: nothing here changes
 * from day to day, and it is in the way of the things that do.
 */
function ServiceInfo({ config }: { config: SourceConfig }) {
  return (
    <Paper withBorder p="lg">
      <Section title="This service">
        <FactGrid>
          <Fact label="Log directory" mono>
            {config.csv_dir}
          </Fact>
          <Fact label="Writing">
            {config.writes_csv
              ? "yes — every reading is appended as it is taken"
              : "no — reading saved logs, nothing is written"}
          </Fact>
          <Fact label="Poll rate">{`every ${formatDuration(config.poll_interval)}`}</Fact>
          <Fact label="Kept in memory">
            {`${formatDuration(config.history_limit * config.poll_interval)} per channel; older readings stay in the file and are read back when a chart asks for them`}
          </Fact>
          <Fact label="Running since">{formatStamp(config.started_at)}</Fact>
        </FactGrid>
      </Section>
    </Paper>
  )
}
