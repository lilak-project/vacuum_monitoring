/** Shapes returned by the backend.  Kept in step with `backend/app/schemas.py`. */

export type Mode = "live" | "attach"
/** Where one device's numbers come from. */
export type DeviceSource = "serial" | "remote" | "file"
export type Measure = "pressure" | "temperature"

/** One measurement of one device, as it stands right now. */
export interface ChannelReading {
  index: number
  label: string
  /** The unit the instrument itself reported. */
  unit: string
  value: number | null
  at: number | null
  points: number
  recorded: number
  /** Samples that have aged out of the in-memory buffer. */
  dropped: number
  first_at: number | null
  last_at: number | null
}

/** A device's metadata and current reading.  Never its history. */
export interface DeviceSnapshot {
  id: string
  name: string
  device_type: string
  measure: Measure
  source: DeviceSource
  /** The profile that opened it, when one did. */
  profile_id: string | null
  status: string
  last_error: string | null
  opened_at: number | null
  channels: ChannelReading[]
  log_path: string | null
  log_rows: number
  polls: number
  poll_errors: number
  last_poll_at: number | null
  last_poll_ms: number | null
}

/** How a stored value became the value on screen. */
export interface UnitConversion {
  factor: number
  offset: number
  identity: boolean
  description: string
}

/** One channel's samples over a window, as uPlot wants them: parallel arrays. */
export interface SeriesChannel {
  index: number
  label: string
  unit: string
  device_unit: string
  conversion: UnitConversion
  t: number[]
  v: number[]
  /** Samples in the window before decimation. */
  total: number
  decimated: boolean
}

export interface SeriesResponse {
  id: string
  name: string
  measure: Measure
  source: string
  start: number | null
  end: number | null
  max_points: number
  series: SeriesChannel[]
  /** File series only: 1 unless rows had to be skipped to stay affordable. */
  row_stride?: number
  rows_in_window?: number
  format?: string
  device_type?: string
}

export interface DeviceTypeChannel {
  index: number
  label: string
  /** The driver call the value comes from, as it appears in the code. */
  call: string
  /** What is asked on the wire, when anything is. */
  query: string
}

/** What one kind of instrument is, and how its number is arrived at. */
export interface DeviceSpec {
  name: string
  title: string
  measure: Measure
  channel_count: number
  channels: DeviceTypeChannel[]
  link: string
  arithmetic: string
  unit_note: string
  usb_id: string
  caveats: string[]
  simulated: boolean
  default_unit: string
}

export interface ProvenanceChannel {
  index: number
  label: string
  call: string
  query: string
  device_unit: string
  display_unit: string
  conversion: UnitConversion
  value: number | null
  at: number | null
  at_iso: string | null
  points: number
  /** True when `points` is worked out from file sizes rather than counted. */
  estimated: boolean
  recorded: number
  dropped: number
  first_at: number | null
  last_at: number | null
  span_text: string
}

/** Everything known about where one device's numbers come from. */
export interface Provenance {
  id: string
  name: string
  device_type: string
  measure: Measure
  source: DeviceSource
  status: string
  last_error: string | null
  opened_at: number | null
  opened_at_iso: string | null
  origin: {
    kind: DeviceSource
    summary: string
    port?: string
    path?: string
    url?: string
    remote_id?: string
    format?: string
    formats?: string[]
    filenames?: string[]
    device_spec: DeviceSpec | null
  }
  spec: DeviceSpec | null
  channels: ProvenanceChannel[]
  sampling: {
    reads: string
    plotted: string
    /** What is kept in memory, and what is not. */
    held: string
  }
  storage: {
    writes: boolean
    /** False until the first reading creates the file. */
    started?: boolean
    path?: string
    filename?: string
    rows?: number | null
    value_column?: string
    unit_column?: string
    format?: string
    file_count?: number
    exists?: boolean
    size?: number
    modified?: number | null
  }
  buffer: { limit: number; limit_text: string }
  health: {
    polls: number
    poll_errors: number
    last_poll_at: number | null
    last_poll_ms: number | null
  }
  available_units: string[]
  /** The same account in prose, with **bold** spans. */
  explain: string[]
}

export interface SourceMode {
  id: Mode
  label: string
  detail: string
  available: boolean
  unavailable_reason: string
}

export interface SourceConfig {
  mode: Mode
  poll_interval: number
  history_limit: number
  csv_dir: string
  log_root: string
  started_at: number
  writes_csv: boolean
  modes: SourceMode[]
  default_remote_url: string
  pressure_units: string[]
  temperature_units: string[]
}

export interface SerialPort {
  device: string
  name: string
  description: string
  hwid: string
  vid: number | null
  pid: number | null
  serial_number: string | null
  suggested_types: string[]
  /** False for the built-in /dev/ttyS* lines with nothing on them. */
  physical: boolean
  /** Other processes already holding this port open — two readers on one tty
   *  split the byte stream and both lose readings, so this blocks opening. */
  held_by: { pid: number; command: string; name: string }[]
}

/** Something this service can connect to: an instrument, or another host. */
export type ProfileKind = "serial" | "remote"

export interface Profile {
  id: string
  kind: ProfileKind
  name: string
  /** serial only */
  device_type: string
  port: string
  /** remote only */
  url: string
  autostart: boolean
  /** How its chart is read.  "" is the unit the instrument reports. */
  display_unit: string
  /** null means "decide from what is being measured". */
  log_y: boolean | null
  /** Which quarter of the plot the big grey reading sits in. */
  watermark_at: "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  /** Logs this profile has written, oldest first.  Continue reads them back. */
  log_files: string[]
  /** Merged in from the running monitor, not stored. */
  connected: boolean
  device_ids: string[]
  last_error: string | null
  /** True while the connected run is stitched onto the earlier logs. */
  continued: boolean
}

export interface LogEntry {
  filename: string
  name: string
  size: number
  modified: number
}

export interface LogList {
  csv_dir: string
  mode: Mode
  writing: boolean
  logs: LogEntry[]
}

export interface LogMeta {
  filename: string
  name: string
  format: string
  format_label: string
  header: string[]
  size: number
  first_at: number | null
  last_at: number | null
  span_seconds: number | null
  estimated_rows: number
  device_type: string
  device_name: string
  measure: string
  /** Set when the file was copied in from an earlier install. */
  imported_from: string | null
  imported_at: string | null
}

export interface Sample {
  at: number
  value: number
}

export interface SampleList {
  id: string
  channel: number
  label: string
  unit: string
  samples: Sample[]
}
