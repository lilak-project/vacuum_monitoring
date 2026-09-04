import { Alert, Anchor, Group, SimpleGrid, Stack, Tabs, Text } from "@mantine/core"
import { FileText, Info } from "lucide-react"

import { api } from "@/lib/api"
import { formatBytes, formatCount, formatValue, unitLabel } from "@/lib/format"
import { seriesColor } from "@/lib/palette"
import { formatAgo, formatStamp } from "@/lib/time"
import type { Provenance } from "@/lib/types"

import { Emphasis } from "./emphasis"
import { Fact, FactGrid, Section } from "./section"

/**
 * Where this tab's numbers come from.
 *
 * The question it answers is the one the previous panel could not: a chart was
 * on screen and there was no way to tell which instrument it was reading,
 * which channel of it, whether the value had been averaged, what unit the
 * device itself had reported, or which file it was going into. The service
 * knows all of that. This is it, said out loud -- first as a paragraph, then
 * as the facts.
 */
export function ProvenancePanel({
  provenance,
  channel,
  onChannel,
}: {
  provenance: Provenance
  channel: number
  onChannel: (index: number) => void
}) {
  const current =
    provenance.channels.find((item) => item.index === channel) ?? provenance.channels[0]
  const spec = provenance.spec
  const storage = provenance.storage

  return (
    <Stack gap="lg">
      <Alert
        color="blue"
        variant="light"
        icon={<Info size={18} />}
        title="What you are looking at"
      >
        <Stack gap={6} className="explain">
          {provenance.explain.map((line, index) => (
            <Text size="sm" key={index}>
              <Emphasis text={line} />
            </Text>
          ))}
        </Stack>
      </Alert>

      {provenance.channels.length > 1 ? (
        <Tabs value={String(channel)} onChange={(value) => onChannel(Number(value))}>
          <Tabs.List>
            {provenance.channels.map((item) => (
              <Tabs.Tab
                key={item.index}
                value={String(item.index)}
                leftSection={
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 3,
                      borderRadius: 2,
                      background: seriesColor(item.index),
                    }}
                  />
                }
              >
                {item.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      ) : null}

      <SimpleGrid cols={{ base: 1, md: 2, lg: 3 }} spacing="lg">
        <Section title="The instrument">
          <FactGrid>
            <Fact label="Type">{provenance.device_type}</Fact>
            <Fact label="What it is">{spec?.title}</Fact>
            <Fact label="Connection" mono>
              {spec?.link}
            </Fact>
            <Fact label="USB id" mono>
              {spec?.usb_id}
            </Fact>
            <Fact label="Where from">{provenance.origin.port ?? provenance.origin.url}</Fact>
            <Fact label="Opened">
              {provenance.opened_at ? formatStamp(provenance.opened_at) : null}
            </Fact>
            <Fact label="Reads">
              {formatCount(provenance.health.polls)} ok
              {provenance.health.poll_errors > 0
                ? `, ${formatCount(provenance.health.poll_errors)} failed`
                : ", none failed"}
            </Fact>
            <Fact label="Last read took" mono>
              {provenance.health.last_poll_ms != null
                ? `${provenance.health.last_poll_ms.toFixed(1)} ms`
                : null}
            </Fact>
          </FactGrid>
        </Section>

        <Section title={`Channel — ${current?.label ?? ""}`}>
          <FactGrid>
            <Fact label="Driver call" mono>
              {current?.call}
            </Fact>
            <Fact label="Asked on the wire" mono>
              {current?.query}
            </Fact>
            <Fact label="Device reports">{unitLabel(current?.device_unit ?? "")}</Fact>
            <Fact label="Chart shows">{unitLabel(current?.display_unit ?? "")}</Fact>
            <Fact label="Conversion" mono>
              {current?.conversion.description}
            </Fact>
            <Fact label="Latest" mono>
              {current
                ? `${formatValue(current.value)} ${unitLabel(current.display_unit)} · ${formatAgo(current.at)}`
                : null}
            </Fact>
            <Fact label={current?.estimated ? "In the files" : "Held in memory"}>
              {current
                ? // Counting a month of rows exactly would mean reading every
                  // file, so a file tab says about how many and means it.
                  `${current.estimated ? "about " : ""}${formatCount(current.points)} samples, ${current.span_text}`
                : null}
            </Fact>
            <Fact label="Aged out">
              {current?.estimated
                ? "nothing — files are read from disk a window at a time"
                : current && current.dropped > 0
                  ? `${formatCount(current.dropped)} — older than ${provenance.buffer.limit_text}, still in the file`
                  : "none yet"}
            </Fact>
          </FactGrid>
        </Section>

        <Section title="Sampling and storage">
          <FactGrid>
            <Fact label="Read">{provenance.sampling.reads}</Fact>
            <Fact label="Plotted">{provenance.sampling.plotted}</Fact>
            <Fact label="File" mono>
              {storage.filename ?? "not written on this host"}
            </Fact>
            <Fact label="Value column" mono>
              {storage.value_column}
            </Fact>
            <Fact label="File format">
              {storage.format === "cmms"
                ? "cmms-web / original CMMS"
                : storage.format === "vacuum_monitoring"
                  ? "written by this service"
                  : storage.format}
            </Fact>
            <Fact label="Rows written">
              {storage.writes && storage.started === false
                ? "none yet — the file appears with the first reading"
                : storage.rows != null
                  ? formatCount(storage.rows)
                  : null}
            </Fact>
            <Fact label="File size">{storage.size != null ? formatBytes(storage.size) : null}</Fact>
            <Fact label="Download">
              {storage.filename && storage.started !== false ? (
                <Anchor size="sm" href={api.logDownloadUrl(storage.filename)} download>
                  <Group gap={4} component="span">
                    <FileText size={13} />
                    {storage.filename}
                  </Group>
                </Anchor>
              ) : null}
            </Fact>
          </FactGrid>
        </Section>
      </SimpleGrid>

      {spec && spec.caveats.length > 0 ? (
        <Alert color="yellow" variant="light" title="Worth knowing about this instrument">
          <Stack gap={4}>
            {spec.caveats.map((caveat, index) => (
              <Text size="sm" key={index}>
                {caveat}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}

</Stack>
  )
}
