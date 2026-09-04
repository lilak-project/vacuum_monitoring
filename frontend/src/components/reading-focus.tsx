import { useEffect } from "react"
import { Badge, Group, Modal, Stack, Text } from "@mantine/core"

import { FillText } from "@/components/fill-text"
import { seriesColor } from "@/lib/palette"
import { formatAgo } from "@/lib/time"

/**
 * The readings, and nothing else, filling the screen.
 *
 * For the case the rest of this panel is not for: the chamber is pumping down
 * and somebody wants to watch the number from the other side of the room, or
 * from a bench they cannot reach the keyboard from. Everything that explains
 * the reading is deliberately gone -- it is on the page behind, and any of it
 * here would shrink the only thing this view exists to show.
 *
 * The number is scaled to the space rather than to the viewport, so a reading
 * that grows a digit stays as large as it can be instead of jumping. The unit
 * sits under it: it is the same for every reading and does not need to be read
 * from as far away.
 *
 * The browser is asked for real fullscreen on the way in, since window chrome
 * and a tab bar are exactly the pixels this is trying to spend.
 */
export function ReadingFocus({
  opened,
  onClose,
  name,
  channels,
  latestAt,
  live,
}: {
  opened: boolean
  onClose: () => void
  name: string
  channels: { index: number; label: string; value: string; unit: string }[]
  latestAt: number | null
  live: boolean
}) {
  useEffect(() => {
    if (!opened) return
    // Best effort: a browser may refuse, and the modal is already full-window.
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined)
    }
  }, [opened])

  // One reading gets the whole screen; several share it.
  const each = channels.length > 1 ? `${Math.floor(72 / channels.length)}vh` : "68vh"

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      withCloseButton
      title={
        <Group gap="sm">
          <Text fw={600} size="lg">
            {name}
          </Text>
          <Badge variant="light" color={live ? "teal" : "gray"}>
            {live ? "live" : "not live"}
          </Badge>
        </Group>
      }
      styles={{ body: { height: "calc(100vh - 70px)", paddingTop: 0 } }}
    >
      <Stack h="100%" justify="center" gap={0}>
        {channels.map((channel) => (
          <Stack key={channel.index} gap={0} align="center">
            {channels.length > 1 ? (
              <Text size="lg" c="dimmed" fw={500}>
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    height: 4,
                    borderRadius: 2,
                    marginRight: 8,
                    verticalAlign: "middle",
                    background: seriesColor(channel.index),
                  }}
                />
                {channel.label}
              </Text>
            ) : null}
            <FillText height={each}>{channel.value}</FillText>
            {/* Under the number, and a fraction of its size: the unit is the
                same on every reading, so it is read once and then known. */}
            <Text c="dimmed" fw={500} fz={channels.length > 1 ? "1.6rem" : "3vw"} lh={1}>
              {channel.unit}
            </Text>
          </Stack>
        ))}
        <Text c="dimmed" size="lg" className="tabular" ta="center" mt="xl">
          {formatAgo(latestAt)}
        </Text>
      </Stack>
    </Modal>
  )
}
