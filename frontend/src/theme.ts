import {
  Badge,
  Button,
  Container,
  createTheme,
  Paper,
  rem,
  Tabs,
  TextInput,
} from "@mantine/core"

/**
 * Theme for a beamline monitoring panel.
 *
 * The same reasoning as the actuator panel it sits beside: the screen is read
 * from a metre away in a lit room, so type and targets are large and the
 * accent colour is spent only on controls that do something. Nothing here
 * drives hardware, so the page is wider -- a chart wants the room.
 */
/** Wider than the actuator panel: a day of pressure needs the pixels. */
export const CONTENT_WIDTH = 1320

/** The one button footprint used across the app. */
export const BUTTON_WIDTH = 156
export const BUTTON_HEIGHT = 46

export const theme = createTheme({
  primaryColor: "blue",
  primaryShade: 7,
  defaultRadius: "md",

  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: '"Geist Mono Variable", ui-monospace, SFMono-Regular, monospace',
  headings: { fontWeight: "600" },

  // Still a touch larger than Mantine's defaults, for reading at arm's length.
  fontSizes: {
    xs: rem(12),
    sm: rem(14),
    md: rem(15),
    lg: rem(16),
    xl: rem(19),
  },
  lineHeights: { md: "1.55" },
  spacing: { xs: rem(10), sm: rem(14), md: rem(20), lg: rem(28), xl: rem(40) },

  components: {
    Button: Button.extend({
      defaultProps: { size: "md", radius: "md" },
    }),
    TextInput: TextInput.extend({
      defaultProps: { size: "md" },
    }),
    Tabs: Tabs.extend({
      defaultProps: { variant: "default" },
    }),
    Paper: Paper.extend({
      defaultProps: { radius: "lg" },
    }),
    Badge: Badge.extend({
      // Names like "24 h" and "Not logging" are read as words, not shouted.
      styles: { label: { textTransform: "none" } },
    }),
    Container: Container.extend({
      defaultProps: { size: CONTENT_WIDTH },
    }),
  },
})
