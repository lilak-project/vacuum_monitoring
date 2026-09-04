import { useEffect, useState } from "react"

import { api, errorMessage } from "@/lib/api"
import type { Provenance } from "@/lib/types"

/**
 * The account of where one device's numbers come from.
 *
 * Re-read on a slow timer rather than pushed: none of it changes from second
 * to second, but row counts, file sizes and the age of the last reading do
 * drift, and a panel headed "where this came from" that is quietly ten minutes
 * stale would be its own small lie.
 */
export function useProvenance(deviceId: string | null, units: Record<number, string>) {
  const [provenance, setProvenance] = useState<Provenance | null>(null)
  const [error, setError] = useState<string | null>(null)

  const unitKey = Object.entries(units)
    .map(([index, unit]) => `${index}:${unit}`)
    .sort()
    .join(",")

  useEffect(() => {
    if (!deviceId) {
      setProvenance(null)
      return
    }
    let cancelled = false

    const load = async () => {
      try {
        const parsed: Record<number, string> = {}
        for (const pair of unitKey.split(",")) {
          if (!pair) continue
          const [index, unit] = pair.split(":")
          parsed[Number(index)] = unit
        }
        const response = await api.provenance(deviceId, parsed)
        if (cancelled) return
        setProvenance(response)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    }

    void load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [deviceId, unitKey])

  return { provenance, error }
}
