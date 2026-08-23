/**
 * Turning a number into text a human reads: a clock, a date, an age.
 *
 * @module
 */

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
 * How long ago something happened, for a list of sessions.
 *
 * Coarse on purpose, and coarser the further back it goes: choosing between
 * this morning and last Tuesday needs an hour, not a millisecond. Past a week
 * it gives up on "ago" entirely and says the date, because "9d ago" is
 * arithmetic somebody has to do.
 *
 * @param time - milliseconds since the epoch.
 * @param now - what to measure against; defaults to the clock.
 * @returns a phrase short enough to sit in one line of a menu.
 */
export function formatAge(time: number, now: number = Date.now()): string {
  const seconds = Math.round((now - time) / 1000)
  // A clock that is behind the server's reads as the future. "In 3 minutes"
  // would be a true statement about two computers and a useless one about a
  // session.
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(time)
}

/**
 * A calendar date, in the reader's own timezone.
 *
 * @param time - milliseconds since the epoch.
 * @returns `YYYY-MM-DD`.
 */
export function formatDate(time: number): string {
  const at = new Date(time)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}
