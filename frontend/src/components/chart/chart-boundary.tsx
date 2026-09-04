import { Component, type ReactNode } from "react"
import { Alert, Code, Stack, Text } from "@mantine/core"
import { AlertTriangle } from "lucide-react"

/**
 * Keep a chart failure inside the chart.
 *
 * uPlot draws into a canvas it owns, and a bad option or an unexpected shape
 * of data throws during its construction -- which without this takes the whole
 * panel down with it and leaves the operator looking at a blank page with the
 * reason only in a console they are not going to open. A monitoring screen
 * that fails should say what failed.
 */
interface State {
  error: Error | null
}

export class ChartBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Still worth having in the console for anyone who does open it.
    console.error("chart failed to render", error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <Alert color="red" icon={<AlertTriangle size={18} />} title="The chart could not be drawn">
        <Stack gap="xs">
          <Text size="sm">
            The readings above are still being taken and logged — this is the plot failing, not
            the measurement.
          </Text>
          <Code block>{`${error.name}: ${error.message}`}</Code>
          <Text size="xs" c="dimmed">
            Reload the page to try again. If it keeps happening, this message is what to report.
          </Text>
        </Stack>
      </Alert>
    )
  }
}
