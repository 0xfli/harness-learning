/**
 * The session log: an append-only, immutable, sequenced record of everything
 * the harness knows, plus a post-commit feed for anyone watching it grow.
 *
 * Nothing here knows about HTTP. Broadcasting to real clients is a transport
 * concern layered on top of {@link SessionLog.observe}.
 *
 * @module @harness/session
 */

import { deepFreeze, snapshotJsonValue } from './json.ts'
import { asSessionEvent } from './jsonl.ts'
import type { JsonObject, SessionEvent, SessionObserver, Unobserve } from './types.ts'

export { deepFreeze, snapshotJsonValue } from './json.ts'
export { asSessionEvent, decodeEvent, encodeEvent } from './jsonl.ts'
export type { JsonObject, JsonValue, SessionEvent, SessionObserver, Unobserve } from './types.ts'

/** Knobs a caller may want to control, mostly for tests. */
export interface SessionLogOptions {
  /**
   * Events this log already contains — a session read back from a journal.
   *
   * Restoring is loading the facts, not rebuilding a state: history is the log
   * and everything else is derived from it again, so a process that comes back
   * has nothing else to rehydrate. Must be dense and zero-based, because `seq`
   * is a position and a log with a hole in it is not the log.
   */
  readonly history?: readonly SessionEvent[]
  /** Wall clock used to stamp events. Defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Where a throwing observer's failure goes. Defaults to `console.error`.
   *
   * An observer runs *after* the append is committed, so it has no say in
   * whether the event exists — its only options are to be reported or to be
   * swallowed. Reported is better.
   */
  readonly onObserverError?: (error: unknown, event: SessionEvent) => void
}

/**
 * An append-only log of {@link SessionEvent}s.
 *
 * The log is the system of record. Facts enter through {@link append} and
 * never leave, never change, and never change order.
 */
export class SessionLog {
  readonly #log: SessionEvent[] = []
  readonly #observers = new Set<SessionObserver>()
  readonly #now: () => number
  readonly #onObserverError: (error: unknown, event: SessionEvent) => void

  /** Cached frozen view of `#log`, invalidated on every append. */
  #snapshot: readonly SessionEvent[] | undefined

  /** True from the start of an append until its observers have all run. */
  #appending = false

  constructor(options: SessionLogOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#onObserverError =
      options.onObserverError ??
      ((error, event) => {
        console.error(`session observer failed for event #${event.seq} (${event.type})`, error)
      })

    const history = options.history ?? []
    for (const [index, candidate] of history.entries()) {
      const event = asSessionEvent(candidate)
      if (event === undefined) {
        throw new TypeError(`restored history[${index}] is not a session event`)
      }
      if (event.seq !== index) {
        // `seq` is a position, and `append` derives the next one from the
        // length. A history that skips 4 would hand the next fact seq 4 as
        // well, so two different facts would answer to one number and every
        // cursor downstream would be pointing at whichever arrived last.
        throw new TypeError(
          `restored history[${index}] has seq ${event.seq}: history must be dense and zero-based`,
        )
      }
      this.#log.push(event)
    }
  }

  /** Number of events recorded so far, which is also the next `seq`. */
  get length(): number {
    return this.#log.length
  }

  /**
   * Every event so far, in `seq` order.
   *
   * @returns a frozen snapshot; later appends do not appear in it.
   */
  get events(): readonly SessionEvent[] {
    this.#snapshot ??= Object.freeze(this.#log.slice())
    return this.#snapshot
  }

  /**
   * One event by position.
   *
   * @param seq - the sequence number to look up.
   * @returns the event, or `undefined` when it has not been appended yet.
   */
  at(seq: number): SessionEvent | undefined {
    return this.#log[seq]
  }

  /**
   * The tail of the log from `seq` onwards — what a reconnecting client missed.
   *
   * @param seq - first sequence number to include; clamped at zero.
   * @returns a frozen slice in `seq` order, empty when `seq` is past the end.
   */
  since(seq: number): readonly SessionEvent[] {
    return Object.freeze(this.#log.slice(Math.max(0, seq)))
  }

  /**
   * Record a fact.
   *
   * The order of operations is the whole point:
   *
   * 1. Snapshot and validate `data`, so a bad payload fails before the log
   *    changes.
   * 2. Assign `seq` and `time`, then deep-freeze the event.
   * 3. Push it — the append is now committed and irreversible.
   * 4. Only then notify observers.
   *
   * Commit before broadcast, never the reverse. An observer that reads the log
   * must see the event that woke it; a client that is told about `seq` 7 must
   * be able to fetch `seq` 7.
   *
   * @param type - namespaced kind of fact, e.g. `demo/hello`.
   * @param data - JSON record payload; deep-copied, so the caller may keep and
   *   mutate its own object freely.
   * @returns the committed, deep-frozen event.
   * @throws if `type` is not a non-empty string, if `data` is not a JSON
   *   record, or if called re-entrantly from an observer.
   */
  append<T extends string>(type: T, data: JsonObject = {}): SessionEvent<T> {
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('session event type must be a non-empty string')
    }
    const snapshot = snapshotJsonValue(data)
    if (
      snapshot === undefined ||
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      throw new TypeError(`session event "${type}" data must be a JSON record`)
    }

    // A log is a sequence, so an append has to be a point in time, not an
    // interval that another append can nest inside. Appending from an observer
    // would interleave `seq` assignment with someone else's broadcast, so
    // observers see events out of order and reason about a log that is halfway
    // through changing. Refuse loudly instead.
    if (this.#appending) {
      throw new Error(
        `cannot append "${type}" from inside a session observer: the log is mid-broadcast`,
      )
    }

    const event = deepFreeze({
      seq: this.#log.length,
      type,
      time: this.#now(),
      data: snapshot,
    }) as SessionEvent<T>

    this.#appending = true
    try {
      // Taken before the commit so that an observer registered *by* an
      // observer starts at the next event rather than re-entering this one.
      const observers = [...this.#observers]

      this.#log.push(event)
      this.#snapshot = undefined

      for (const observer of observers) {
        // Detaching during dispatch takes effect immediately, so a client that
        // just disconnected is not handed one more event.
        if (!this.#observers.has(observer)) continue
        try {
          observer(event)
        } catch (error) {
          // The event is already committed. A broken observer is a broken
          // observer, not a reason to pretend the fact never happened.
          this.#onObserverError(error, event)
        }
      }
      return event
    } finally {
      this.#appending = false
    }
  }

  /**
   * Watch the log grow.
   *
   * Observers hear about events appended *after* they subscribe. Existing
   * history is read from {@link events} or {@link since} — and because
   * `append` is synchronous, reading history and subscribing in the same tick
   * leaves no window for an event to slip through.
   *
   * @param observer - called once per committed event, in `seq` order.
   * @returns a function that detaches the observer.
   */
  observe(observer: SessionObserver): Unobserve {
    if (typeof observer !== 'function') {
      throw new TypeError('session observer must be a function')
    }
    this.#observers.add(observer)
    return () => {
      this.#observers.delete(observer)
    }
  }

  /** How many observers are currently attached. */
  get observerCount(): number {
    return this.#observers.size
  }
}
