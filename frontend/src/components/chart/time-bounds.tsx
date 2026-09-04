import { useMemo } from "react"
import { Group, Select, Text } from "@mantine/core"

import type { TimeRangeControl } from "./use-time-range"

/**
 * The exact ends of the window, chosen rather than typed.
 *
 * Typing `2026-08-29 14:30` is precise and slow, and it is wrong in a dozen
 * ways that all look the same. Picking a day and a time cannot be malformed,
 * and the days offered are only the days that have readings in them -- so the
 * control will not take you somewhere the gauge was switched off.
 *
 * It sits under the chart because it is the fine adjustment. The presets and a
 * drag on the plot are how a window is usually chosen; this is for "start it
 * exactly at nine".
 */
export function TimeBounds({
  range,
  dataStart,
  dataEnd,
}: {
  range: TimeRangeControl
  dataStart: number | null
  dataEnd: number | null
}) {
  const now = Date.now() / 1000
  const first = dataStart ?? now - 3600
  const last = dataEnd ?? now

  // One entry per day that holds readings, newest last.
  const days = useMemo(() => {
    const out: { value: string; label: string }[] = []
    const cursor = new Date(first * 1000)
    cursor.setHours(0, 0, 0, 0)
    const end = new Date(last * 1000)
    end.setHours(0, 0, 0, 0)
    // A guard, not a limit anybody should hit: four months of daily entries is
    // a long dropdown but a fine one; four thousand would be a hung tab.
    for (let guard = 0; cursor <= end && guard < 800; guard += 1) {
      out.push({ value: dayKey(cursor), label: dayLabel(cursor) })
      cursor.setDate(cursor.getDate() + 1)
    }
    return out
  }, [first, last])

  return (
    <Group gap="lg" wrap="wrap" align="flex-end">
      <Bound label="From" at={range.window.from} days={days}
        onChange={(seconds) => range.setWindow(seconds, range.window.to)} />
      <Bound label="To" at={range.window.to} days={days}
        onChange={(seconds) => range.setWindow(range.window.from, seconds)} />
      <Text size="xs" c="dimmed" pb={6}>
        Only days with readings are offered.
      </Text>
    </Group>
  )
}

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: String(hour).padStart(2, "0"),
}))

// Five-minute steps: fine enough to place a window, coarse enough to pick from
// without scrolling. Anything finer is a drag on the chart.
const MINUTES = Array.from({ length: 12 }, (_, step) => ({
  value: String(step * 5),
  label: String(step * 5).padStart(2, "0"),
}))

function Bound({
  label,
  at,
  days,
  onChange,
}: {
  label: string
  at: number
  days: { value: string; label: string }[]
  onChange: (seconds: number) => void
}) {
  const date = new Date(at * 1000)
  const day = dayKey(date)
  // Snapped to the nearest offered step so the box never shows a value that is
  // not in its own list.
  const minute = String(Math.round(date.getMinutes() / 5) * 5 % 60)

  const move = (parts: { day?: string; hour?: number; minute?: number }) => {
    const next = new Date(at * 1000)
    if (parts.day) {
      const [year, month, dayOfMonth] = parts.day.split("-").map(Number)
      next.setFullYear(year, month - 1, dayOfMonth)
    }
    if (parts.hour !== undefined) next.setHours(parts.hour)
    if (parts.minute !== undefined) next.setMinutes(parts.minute)
    next.setSeconds(0, 0)
    onChange(next.getTime() / 1000)
  }

  return (
    <Group gap={6} align="flex-end">
      <Text size="sm" c="dimmed" w={38} pb={7}>
        {label}
      </Text>
      <Select
        size="sm"
        w={148}
        aria-label={`${label} day`}
        data={days}
        value={days.some((item) => item.value === day) ? day : (days.at(-1)?.value ?? null)}
        onChange={(value) => value && move({ day: value })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
      <Select
        size="sm"
        w={72}
        aria-label={`${label} hour`}
        data={HOURS}
        value={String(date.getHours())}
        onChange={(value) => value && move({ hour: Number(value) })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
      <Text size="sm" c="dimmed" pb={7}>
        :
      </Text>
      <Select
        size="sm"
        w={72}
        aria-label={`${label} minute`}
        data={MINUTES}
        value={minute}
        onChange={(value) => value && move({ minute: Number(value) })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
    </Group>
  )
}

const pad = (value: number) => String(value).padStart(2, "0")

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayLabel(date: Date): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - date.getTime()) / 86400000)
  const stamp = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
  if (days === 0) return `${stamp} · today`
  if (days === 1) return `${stamp} · yesterday`
  return stamp
}
