/**
 * Sessions, plural: how one session is named, how it is summarised, and what
 * a place that keeps several of them has to be able to do.
 *
 * Everything here is pure. A **session store** is an interface rather than a
 * class because the harness has more than one honest answer to "where do
 * sessions live?" — a directory of journals on a developer's disk, or nothing
 * at all for a run that should leave no trace — and the server should not know
 * which one it got.
 *
 * A **session summary** is a projection, folded out of the events it
 * describes. It is never stored alongside a session, because a title or a
 * count written down next to a log is a second source of truth that starts
 * lying the moment the log grows.
 *
 * @module
 */

import type { SessionLog } from './index.ts'
import type { SessionEvent } from './types.ts'

/** Longest title a summary carries. A picker shows one line, not a paragraph. */
const MAX_TITLE_LENGTH = 80

/**
 * What a session looks like from the outside, without opening it.
 *
 * Enough to choose one from a list and no more: the log itself is the answer
 * to every other question, and it is one request away.
 */
export interface SessionSummary {
  /** Names the session, and its journal. Sorts oldest to newest as a string. */
  readonly id: string
  /** How many events the session holds. */
  readonly events: number
  /** When the first event was appended; `undefined` while the log is empty. */
  readonly startedAt: number | undefined
  /** When the last event was appended; `undefined` while the log is empty. */
  readonly updatedAt: number | undefined
  /**
   * The first thing the human said, trimmed to one line. `undefined` when
   * nobody has said anything yet — a session is named by its opening question
   * or not at all, because anything else would be a name somebody has to
   * maintain.
   */
  readonly title: string | undefined
}

/** A session that is open: its log, and a way to let go of it. */
export interface OpenSession {
  readonly id: string
  /** The log itself. Appending to it is what makes the session durable. */
  readonly log: SessionLog
  /** Detach from the session. The store forgets it; the events remain. */
  close(): void
}

/**
 * Somewhere sessions are kept.
 *
 * Opening is the only expensive operation, and it is the one nobody performs
 * by accident: {@link list} and {@link summarise} read without opening, which
 * is what lets a picker show twenty sessions while the harness holds one.
 */
export interface SessionStore {
  /** Every session this store knows of, most recently active first. */
  list(): readonly SessionSummary[]
  /** Whether a session with this id has been recorded or opened. */
  has(id: string): boolean
  /** One session's summary, or `undefined` when there is no such session. */
  summarise(id: string): SessionSummary | undefined
  /**
   * Open a session and keep it open.
   *
   * Idempotent: asking twice hands back the same open session, because two
   * logs over one journal would be two answers to what happened.
   *
   * A session that has never recorded anything and a session that does not
   * exist are the same empty log, so this cannot fail on an unknown id.
   * Callers that care — a server handed an id by a stranger, say — ask
   * {@link has} first.
   *
   * @param id - the session to open.
   * @throws when `id` is not a session id.
   */
  open(id: string): OpenSession
  /** Start a session nobody has used before, and open it. */
  create(): OpenSession
  /** Close every session this store has open. */
  close(): void
}

/**
 * The shape of a session id: what a store is allowed to turn into a filename.
 *
 * Deliberately strict. An id arrives from a URL, and a store spells it into a
 * path — so anything that is not a plain, non-empty name is not an id, and the
 * two characters that would make it a traversal are simply not in the set.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Whether a string may name a session.
 *
 * @param value - the candidate id, from a URL, a file name, or an environment
 *   variable.
 * @returns true when it is a session id.
 */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value)
}

/**
 * Refuse anything that is not a session id.
 *
 * @param value - the candidate id.
 * @returns the id, unchanged.
 * @throws TypeError when the value could not name a session.
 */
export function asSessionId(value: string): string {
  if (!isSessionId(value)) throw new TypeError(`"${value}" is not a session id`)
  return value
}

/** How to name a new session. */
export interface NewSessionIdOptions {
  /** Wall clock the id is stamped from. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Source of the suffix. Defaults to `Math.random`. */
  readonly random?: () => number
}

/**
 * Name a session after the moment it started.
 *
 * `20260823-074139-k3f9`: UTC, so the ordering never doubles back over a
 * daylight-saving boundary, and sortable as a string, so a directory listing
 * is already in the order a human wants to read it. The suffix is what keeps
 * two sessions started in the same second apart.
 *
 * @param options - clock and randomness, for tests that need both fixed.
 * @returns a fresh session id.
 */
export function newSessionId(options: NewSessionIdOptions = {}): string {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const stamp = new Date(now()).toISOString().replaceAll(/[-:]/g, '').replace('T', '-')
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${stamp.slice(0, 15)}-${suffix}`
}

/**
 * Fold a session's events into the little that a list needs.
 *
 * @param id - the session being described.
 * @param events - its events, in `seq` order.
 * @returns the summary.
 */
export function summariseEvents(id: string, events: readonly SessionEvent[]): SessionSummary {
  const first = events.at(0)
  const last = events.at(-1)
  return {
    id,
    events: events.length,
    startedAt: first?.time,
    updatedAt: last?.time,
    title: titleOf(events),
  }
}

/**
 * Name a session after the first thing the human said to it.
 *
 * The opening question is the one label nobody has to invent, keep in step, or
 * migrate: it is already in the log.
 */
function titleOf(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = event.data['text']
    if (typeof text !== 'string') continue
    const line = text.replaceAll(/\s+/g, ' ').trim()
    if (line.length === 0) continue
    return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line
  }
  return undefined
}
