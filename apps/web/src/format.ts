/**
 * Turning an event into one line of text.
 *
 * @module
 */

import type { JsonObject } from '@harness/session'

/**
 * A wall clock reading, to the millisecond.
 *
 * Events are milliseconds since the epoch; a stream of them is only readable
 * as a clock, and the milliseconds are the interesting part once a model
 * starts emitting chunks.
 *
 * @param time - milliseconds since the epoch.
 * @returns `HH:MM:SS.mmm` in the reader's own timezone.
 */
export function formatClock(time: number): string {
  const at = new Date(time)
  return (
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}`
  )
}

/**
 * An event payload as a single line.
 *
 * @param data - the event payload.
 * @returns compact JSON, or an empty string for an empty payload — a lone
 *   `{}` on every row is noise, and the type already said what happened.
 */
export function formatData(data: JsonObject): string {
  const json = JSON.stringify(data)
  return json === '{}' ? '' : json
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}
