import { Fragment } from "react"

/**
 * Render the `**bold**` spans the backend's explanation sentences carry.
 *
 * The sentences name files, ports and device names, and those are the words a
 * reader scans for -- so they arrive marked and are set in bold here. Split
 * rather than parsed: the text is the service's own, but it is still text
 * going into the DOM, and there is no reason for it to go in as HTML.
 */
export function Emphasis({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={index}>{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  )
}
