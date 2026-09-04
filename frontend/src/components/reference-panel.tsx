import { useEffect, useState } from "react"
import { Alert, Badge, Code, Group, Paper, Stack, Table, Text } from "@mantine/core"

import { Fact, FactGrid, Section } from "@/components/section"
import { api } from "@/lib/api"
import type { DeviceSpec } from "@/lib/types"

/**
 * What every instrument this service can read actually measures.
 *
 * Static, so it answers with nothing connected -- which is when the question
 * usually gets asked. It is the same account the provenance panel gives for a
 * live device, minus the device: the wiring, the arithmetic, where the unit
 * comes from, and what each one will not tell you.
 */
export function ReferencePanel() {
  const [specs, setSpecs] = useState<DeviceSpec[]>([])

  useEffect(() => {
    void api.listDeviceTypes().then(setSpecs).catch(() => undefined)
  }, [])

  return (
    <Stack gap="xl">
      <Alert variant="light" color="blue" title="Reading this page">
        Every number this service shows comes from one of the instruments below, through the
        driver call named against its channel. Nothing is inferred and nothing is modelled — if
        a value is on a chart, a gauge reported it and the arithmetic here turned it into a
        number.
      </Alert>

      {specs.map((spec) => (
        <Paper withBorder p="lg" radius="lg" key={spec.name}>
          <Section
            title={spec.name}
            description={spec.title}
            action={
              <Group gap="xs">
                <Badge variant="light" color={spec.measure === "pressure" ? "blue" : "grape"}>
                  {spec.measure}
                </Badge>
                {spec.simulated ? (
                  <Badge variant="light" color="yellow">
                    simulated
                  </Badge>
                ) : null}
              </Group>
            }
          >
            <FactGrid>
              <Fact label="Connection" mono>
                {spec.link}
              </Fact>
              <Fact label="USB id" mono>
                {spec.usb_id}
              </Fact>
              <Fact label="How the number is made">{spec.arithmetic}</Fact>
              <Fact label="Unit">{spec.unit_note}</Fact>
            </FactGrid>

            <Table verticalSpacing="xs" withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Channel</Table.Th>
                  <Table.Th>Driver call</Table.Th>
                  <Table.Th>Asked on the wire</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {spec.channels.map((channel) => (
                  <Table.Tr key={channel.index}>
                    <Table.Td fw={500}>{channel.label}</Table.Td>
                    <Table.Td>
                      <Code>{channel.call}</Code>
                    </Table.Td>
                    <Table.Td c="dimmed" className="tabular">
                      {channel.query || "—"}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {spec.caveats.length > 0 ? (
              <Stack gap={4}>
                {spec.caveats.map((caveat, index) => (
                  <Text size="sm" c="dimmed" key={index}>
                    · {caveat}
                  </Text>
                ))}
              </Stack>
            ) : null}
          </Section>
        </Paper>
      ))}

      <Paper withBorder p="lg" radius="lg">
        <Section
          title="The CSV files"
          description="Two headers exist. This service writes the first and reads both, so nothing already on disk became unreadable."
        >
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Column</Table.Th>
                <Table.Th>What is in it</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[
                ["time", 'The wall clock, wrapped as ="…" so Excel leaves it alone'],
                ["unix_time", "Seconds since the epoch, to the millisecond — the column every chart is drawn from"],
                ["elapsed_s", "Seconds since the first row of this file"],
                ["channel", "1-based channel number of the instrument"],
                ["channel_label", 'What that channel is called — "Pressure", "Sensor 3"'],
                ["value", "The reading, in the unit beside it"],
                ["unit", "The unit the instrument itself reported"],
                ["measure", "pressure or temperature"],
                ["device_type", "BCG450, TPG36X, LS218, TIC100"],
                ["device_name", "The name the operator gave it"],
              ].map(([column, meaning]) => (
                <Table.Tr key={column}>
                  <Table.Td>
                    <Code>{column}</Code>
                  </Table.Td>
                  <Table.Td>{meaning}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Text size="sm" c="dimmed">
            Files written by cmms-web and the original CMMS program name their value column{" "}
            <Code>pressure_raw</Code> and its unit <Code>raw_unit</Code>, and carry no channel
            label, measure or device type. Those are read as pressure, and the device type is
            recovered from the filename when it names one this service knows. Every panel that
            reads a file says which of the two it found.
          </Text>
        </Section>
      </Paper>

      <Paper withBorder p="lg" radius="lg">
        <Section
          title="Units"
          description="Conversions are a factor the service applies on the way out, never on the way in. What is written to the CSV is always what the instrument said."
        >
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Unit</Table.Th>
                <Table.Th ta="right">Pascals in one</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[
                ["Pa", "1"],
                ["hPa", "100"],
                ["mbar", "100"],
                ["Torr", "133.32236842105263"],
                ["Micron (mTorr)", "0.13332236842105263"],
                ["atm", "101325"],
                ["psi", "6894.757293168361"],
              ].map(([unit, pascals]) => (
                <Table.Tr key={unit}>
                  <Table.Td fw={500}>{unit}</Table.Td>
                  <Table.Td ta="right" className="tabular">
                    {pascals}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="sm" c="dimmed">
            Temperature goes through kelvin: °C = K − 273.15, °F = K × 9/5 − 459.67.
          </Text>
        </Section>
      </Paper>
    </Stack>
  )
}
