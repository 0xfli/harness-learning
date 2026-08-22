/**
 * One event, one line.
 *
 * JSONL is chosen for what it does under a partial write rather than for what
 * it does when everything works. A single JSON document has to be rewritten
 * whole and re-parsed whole: a process killed mid-write leaves a file that
 * parses as nothing at all, so the failure mode of appending one fact is
 * losing every fact. Line-delimited records fail per line, and a line that
 * never finished is the last one — the prefix in front of it is untouched and
 * still true.
 *
 * Nothing here touches a filesystem. This module is the format; `journal.ts`
 * is the file.
 *
 * @module
 */

import { deepFreeze } from './json.ts'
import type { JsonObject, SessionEvent } from './types.ts'

/** The fields an event has, in the order `append` writes them. */
const EVENT_KEYS = ['seq', 'type', 'time', 'data'] as const

/**
 * Write one event as a line, terminator included.
 *
 * The terminator is part of the encoding, not something the caller remembers
 * to add: a line without it is by definition a line that is still being
 * written, and that distinction is the whole recovery story.
 *
 * @param event - the committed event to write down.
 * @returns the line, ending in `\n`. JSON escapes any newline inside the
 *   payload, so a line break in the file is always a record boundary.
 */
export function encodeEvent(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Read one line back, or refuse it.
 *
 * Strict on purpose, including about keys it does not know: a reader that
 * quietly drops an unrecognised field turns "I cannot read this" into "this is
 * what it said", which is the one thing a ledger may never do. Refusing is
 * also what makes re-encoding a decoded event reproduce the original bytes.
 *
 * @param line - one line from a journal, without its terminator.
 * @returns the deep-frozen event, or `undefined` when the line is blank,
 *   truncated, not JSON, or not shaped like an event.
 */
export function decodeEvent(line: string): SessionEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  return asSessionEvent(parsed)
}

/**
 * Check a value is an event and freeze it, or refuse.
 *
 * The gate between "some JSON that came from outside" and the log's own
 * invariants. Used by `decodeEvent` on the way in from a file, and by
 * `SessionLog` on the way in from restored history.
 *
 * @param value - a candidate parsed from JSON.
 * @returns the same value, deep-frozen and typed, or `undefined`.
 */
export function asSessionEvent(value: unknown): SessionEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>

  const keys = Object.keys(candidate)
  if (keys.length !== EVENT_KEYS.length) return undefined
  if (!EVENT_KEYS.every((key) => Object.hasOwn(candidate, key))) return undefined

  const { seq, type, time, data } = candidate
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined

  // Key order is part of the encoding: `JSON.stringify` writes insertion
  // order, so an event rebuilt in `append`'s order re-encodes byte for byte.
  return deepFreeze({ seq, type, time, data: data as JsonObject })
}
