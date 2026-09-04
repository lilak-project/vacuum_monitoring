import { useEffect, useRef, useState } from "react"

import { BASE } from "@/lib/portal-base"

import type { DeviceSnapshot, Mode } from "@/lib/types"

interface StatusFrame {
  type: "status"
  mode: Mode
  devices: DeviceSnapshot[]
}

export interface StatusStream {
  devices: DeviceSnapshot[]
  mode: Mode | null
  /** True while the socket is open, i.e. the readouts are current. */
  live: boolean
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  // BASE is "" served directly; behind the portal the socket must go through
  // the same `/p/<name>` prefix -- the portal proxies WebSockets there too.
  return `${scheme}//${window.location.host}${BASE}/ws/status`
}

/**
 * Subscribe to the backend's status broadcast.
 *
 * Only the current reading of each device comes down this socket -- history is
 * a query against a window. So a browser watching a run that has been going
 * for a week costs the same as one watching a run that started a minute ago.
 * Reconnects on its own with a capped backoff after a drop.
 */
export function useStatusStream(): StatusStream {
  const [frame, setFrame] = useState<Omit<StatusFrame, "type"> | null>(null)
  const [live, setLive] = useState(false)
  const retryRef = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = () => {
      socket = new WebSocket(socketUrl())

      socket.onopen = () => {
        retryRef.current = 0
        setLive(true)
      }

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StatusFrame
          if (message.type === "status") setFrame(message)
        } catch {
          /* a malformed frame is not worth tearing the socket down for */
        }
      }

      socket.onclose = () => {
        setLive(false)
        if (closed) return
        // 0.5s, 1s, 2s, 4s, capped at 5s.
        const delay = Math.min(500 * 2 ** retryRef.current, 5000)
        retryRef.current += 1
        retryTimer = setTimeout(connect, delay)
      }

      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      closed = true
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  return {
    devices: frame?.devices ?? [],
    mode: frame?.mode ?? null,
    live,
  }
}
