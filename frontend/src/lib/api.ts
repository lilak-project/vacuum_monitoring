import type {
  Me,
  DeviceSnapshot,
  DeviceSpec,
  LogList,
  LogMeta,
  Profile,
  Provenance,
  SampleList,
  SerialPort,
  SeriesResponse,
  SourceConfig,
} from "./types"

import { url } from "@/lib/portal-base"

/** Error carrying the backend's message so the UI can show it verbatim. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    // FastAPI puts a string in `detail` for HTTPException and a list for
    // request-validation failures.
    if (typeof body?.detail === "string") return body.detail
    if (Array.isArray(body?.detail)) {
      return body.detail.map((item: { msg?: string }) => item.msg ?? "Invalid value").join("; ")
    }
  } catch {
    /* fall through to the status text */
  }
  return response.statusText || `Request failed (${response.status})`
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

/** `{0: "mbar"}` -> `0:mbar`, the form the series and provenance routes take. */
export function unitParam(units: Record<number, string>): string {
  return Object.entries(units)
    .map(([index, unit]) => `${index}:${unit}`)
    .join(",")
}

interface WindowQuery {
  from?: number | null
  to?: number | null
  maxPoints?: number
  units?: Record<number, string>
  channel?: number
  /** Aborts the request when a newer window supersedes this one. */
  signal?: AbortSignal
}

function windowSearch(query: WindowQuery): string {
  const params = new URLSearchParams()
  if (query.from != null) params.set("from", String(query.from))
  if (query.to != null) params.set("to", String(query.to))
  if (query.maxPoints != null) params.set("max_points", String(query.maxPoints))
  if (query.channel != null) params.set("channel", String(query.channel))
  const units = query.units ? unitParam(query.units) : ""
  if (units) params.set("units", units)
  const search = params.toString()
  return search ? `?${search}` : ""
}

export const api = {
  /** Who is looking, and whether they may control. */
  me: () => request<Me>("/api/me"),

  readSource: () => request<SourceConfig>("/api/source"),

  setSource: (mode: string) =>
    request<SourceConfig>("/api/source", { method: "POST", ...json({ mode }) }),

  listPorts: () => request<SerialPort[]>("/api/ports"),

  /** Static: answers with nothing connected, so the reference screen works. */
  listDeviceTypes: () => request<DeviceSpec[]>("/api/device-types"),

  listDevices: () => request<DeviceSnapshot[]>("/api/devices"),

  /** Everything this service can connect to: instruments and other hosts. */
  listProfiles: () => request<Profile[]>("/api/profiles"),

  saveProfile: (profile: Partial<Profile>) =>
    request<Profile[]>("/api/profiles", { method: "PUT", ...json(profile) }),

  /** Remember the unit and axis a profile's chart is read in. */
  saveProfileView: (
    id: string,
    view: { display_unit?: string; log_y?: boolean | null; watermark_at?: string },
  ) =>
    request<Profile[]>(`/api/profiles/${encodeURIComponent(id)}/view`, {
      method: "PUT",
      ...json(view),
    }),

  /** Choose which logs a profile continues from.  Reconnect to apply. */
  setProfileHistory: (id: string, filenames: string[]) =>
    request<Profile[]>(`/api/profiles/${encodeURIComponent(id)}/history`, {
      method: "PUT",
      ...json({ filenames }),
    }),

  deleteProfile: (id: string) =>
    request<Profile[]>(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** `keepHistory` reads the profile's earlier logs back onto the chart. */
  connectProfile: (id: string, keepHistory = false) =>
    request<DeviceSnapshot[]>(
      `/api/profiles/${encodeURIComponent(id)}/connect?continue=${keepHistory ? "true" : "false"}`,
      { method: "POST" },
    ),

  disconnectProfile: (id: string) =>
    request<void>(`/api/profiles/${encodeURIComponent(id)}/disconnect`, { method: "POST" }),

  /** Open saved logs as one tab, joined end to end in time. */
  attachFiles: (filenames: string[], name = "") =>
    request<DeviceSnapshot>("/api/devices/attach", {
      method: "POST",
      ...json({ filenames, name }),
    }),

  removeDevice: (id: string) =>
    request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),

  provenance: (id: string, units: Record<number, string> = {}) =>
    request<Provenance>(
      `/api/devices/${encodeURIComponent(id)}/provenance${windowSearch({ units })}`,
    ),

  /** The samples in a window, already decimated to what a chart can show. */
  series: (id: string, query: WindowQuery) =>
    request<SeriesResponse>(`/api/devices/${encodeURIComponent(id)}/series${windowSearch(query)}`, {
      signal: query.signal,
    }),

  /** The last few samples as numbers -- the data behind the line. */
  samples: (id: string, channel: number, limit = 20) =>
    request<SampleList>(
      `/api/devices/${encodeURIComponent(id)}/samples?channel=${channel}&limit=${limit}`,
    ),

  listLogs: () => request<LogList>("/api/logs"),

  logMeta: (filename: string) =>
    request<LogMeta>(`/api/logs/${encodeURIComponent(filename)}/meta`),

  logSeries: (filename: string, query: WindowQuery) =>
    request<SeriesResponse>(
      `/api/logs/${encodeURIComponent(filename)}/series${windowSearch(query)}`,
      { signal: query.signal },
    ),

  // Used as an <a href download>, not fetched -- so it carries the prefix itself.
  logDownloadUrl: (filename: string) => url(`/api/logs/${encodeURIComponent(filename)}/download`),
}

/** Message the operator should actually read, from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
