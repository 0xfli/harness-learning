/**
 * The client half of the feed.
 *
 * The server's log is the system of record; this is a replica of it that a
 * view layer can read synchronously. It holds the events received so far and
 * hands them out as a snapshot whose identity changes only when the log
 * actually grew — which is the whole contract behind
 * `useSyncExternalStore`, and the same immutability rule as the server's,
 * seen from the other side.
 *
 * Nothing here knows about React, and nothing here renders. It is a store.
 *
 * @module @harness/session-feed
 */

import { deepFreeze } from '@harness/session'
import type { JsonObject, SessionEvent } from '@harness/session'
import { Listeners } from './listeners.ts'
import type {
  ExternalStore,
  FeedError,
  FeedSource,
  FeedSourceFactory,
  FeedSourceMessage,
  FeedStatus,
} from './types.ts'

/** How to build a feed client. */
export interface SessionFeedOptions {
  /** Feed URL. Relative by default, so it follows whatever origin served the page. */
  readonly url?: string
  /** Transport factory. Defaults to the global `EventSource`. */
  readonly createSource?: FeedSourceFactory
  /**
   * Where a contained failure goes — a malformed frame, a hole in the log, a
   * subscriber that threw. Defaults to `console.error`.
   */
  readonly onError?: (error: FeedError) => void
}

/**
 * A live replica of the session log, exposed as two independent stores.
 *
 * They are separate on purpose: a new event must not re-render the connection
 * indicator, and a reconnect must not re-render the event list.
 */
export interface SessionFeed {
  /** Every event received so far, in `seq` order. */
  readonly events: ExternalStore<readonly SessionEvent[]>
  /** Where the connection is. */
  readonly status: ExternalStore<FeedStatus>
  /** Disconnect and stop applying events. Terminal, and idempotent. */
  close(): void
}

const DEFAULT_URL = '/events'

/**
 * Connect to a feed and start replicating it.
 *
 * The connection opens immediately rather than on first subscriber: the store
 * exists outside the view layer and does not need one to be useful, and a
 * store that connects and disconnects as components mount would reconnect
 * twice under React's development double-render.
 *
 * @param options - feed URL, transport, and error sink.
 * @returns the replica. Call {@link SessionFeed.close} to stop it.
 */
export function createSessionFeed(options: SessionFeedOptions = {}): SessionFeed {
  return new SessionFeedClient(options)
}

class SessionFeedClient implements SessionFeed {
  readonly #url: string
  readonly #createSource: FeedSourceFactory
  readonly #onError: (error: FeedError) => void

  readonly #eventListeners = new Listeners()
  readonly #statusListeners = new Listeners()

  /** Received events, indexed by `seq`, which is also their position. */
  readonly #log: SessionEvent[] = []
  /** Cached frozen view of `#log`, invalidated whenever `#log` changes. */
  #snapshot: readonly SessionEvent[] | undefined
  #status: FeedStatus = 'connecting'
  #source: FeedSource | undefined
  #closed = false

  constructor(options: SessionFeedOptions) {
    this.#url = options.url ?? DEFAULT_URL
    this.#createSource = options.createSource ?? createEventSource
    this.#onError =
      options.onError ??
      ((error) => {
        console.error(`session feed ${error.reason}: ${error.message}`, error.cause ?? '')
      })
    this.#connect()
  }

  /**
   * Every event received so far.
   *
   * `getSnapshot` returns the *same* array until the log changes. Returning a
   * fresh copy per call would be correct data and a broken store: every read
   * would look like a change, and `useSyncExternalStore` would re-render until
   * React gives up.
   */
  readonly events: ExternalStore<readonly SessionEvent[]> = {
    subscribe: (listener) => this.#eventListeners.add(listener),
    getSnapshot: () => {
      this.#snapshot ??= Object.freeze(this.#log.slice())
      return this.#snapshot
    },
  }

  readonly status: ExternalStore<FeedStatus> = {
    subscribe: (listener) => this.#statusListeners.add(listener),
    getSnapshot: () => this.#status,
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#source?.close()
    this.#source = undefined
    this.#setStatus('closed')
  }

  #connect(): void {
    const source = this.#createSource(this.#url)
    this.#source = source
    source.addEventListener('open', () => {
      this.#setStatus('open')
    })
    source.addEventListener('error', () => {
      // `EventSource` retries on its own using the `retry` interval the server
      // advertised, resuming from the last `seq` it saw. Either way the stream
      // is not live right now, which is all this status claims.
      if (!this.#closed) this.#setStatus('reconnecting')
    })
    source.addEventListener('message', (message) => {
      this.#receive(message)
    })
  }

  #receive(message: FeedSourceMessage): void {
    if (this.#closed) return
    const raw = message.data
    if (typeof raw !== 'string') {
      this.#report({ reason: 'malformed-frame', message: 'frame payload was not a string' })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#report({
        reason: 'malformed-frame',
        message: 'frame payload was not JSON',
        cause: error,
      })
      return
    }

    const event = toSessionEvent(parsed)
    if (event === undefined) {
      this.#report({
        reason: 'malformed-frame',
        message: 'frame payload was not a session event',
        cause: parsed,
      })
      return
    }
    this.#apply(event)
  }

  /**
   * Put one event in its place, or admit the replica is wrong.
   *
   * `seq` is a position, not a hint: an event either lands at the end of what
   * we hold or it does not belong here at all. Both failure modes are real —
   * a dropped frame leaves a hole, and a server that restarted with a fresh
   * log replays `seq` 0 with different content — and both mean the array we
   * are holding is no longer a prefix of the server's log. Rendering it
   * anyway would be showing a history that never happened.
   */
  #apply(event: SessionEvent): void {
    const held = this.#log[event.seq]
    if (held !== undefined) {
      // The overlap between replayed history and the live tail is normal:
      // the same event twice is a no-op, not a problem.
      if (held.type === event.type && held.time === event.time) return
      this.#resync({
        reason: 'divergence',
        message: `event #${event.seq} arrived as "${event.type}" but is already held as "${held.type}"`,
      })
      return
    }

    if (event.seq !== this.#log.length) {
      this.#resync({
        reason: 'gap',
        message: `event #${event.seq} arrived while expecting #${this.#log.length}`,
      })
      return
    }

    this.#log.push(event)
    this.#snapshot = undefined
    this.#eventListeners.emit((error) => {
      this.#report({ reason: 'listener', message: 'a feed subscriber threw', cause: error })
    })
  }

  /**
   * Throw away the replica and rebuild it from the server.
   *
   * A brand-new source sends no `Last-Event-ID`, so the server replays from
   * `seq` 0 — which is exactly what a client that has just admitted it holds
   * the wrong history needs.
   */
  #resync(error: FeedError): void {
    this.#report(error)
    if (this.#closed) return

    this.#source?.close()
    this.#source = undefined
    this.#log.length = 0
    this.#snapshot = undefined
    this.#setStatus('reconnecting')
    // Announce the empty replica before reconnecting, so a view never renders
    // from a log it has already been told is wrong.
    this.#eventListeners.emit((listenerError) => {
      this.#report({
        reason: 'listener',
        message: 'a feed subscriber threw',
        cause: listenerError,
      })
    })
    this.#connect()
  }

  #setStatus(next: FeedStatus): void {
    if (this.#status === next) return
    this.#status = next
    this.#statusListeners.emit((error) => {
      this.#report({ reason: 'listener', message: 'a feed subscriber threw', cause: error })
    })
  }

  #report(error: FeedError): void {
    try {
      this.#onError(error)
    } catch {
      // An error sink that throws is out of options; swallowing beats
      // unwinding the transport callback that got us here.
    }
  }
}

/**
 * Validate a parsed frame and freeze it.
 *
 * The server freezes its own events; a replica that trusted the wire and
 * handed out mutable objects would give the view layer a way to rewrite
 * history that the server does not have.
 *
 * @param value - the parsed frame payload.
 * @returns the frozen event, or `undefined` when the payload is not one.
 */
function toSessionEvent(value: unknown): SessionEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { seq, type, time, data } = value as Record<string, unknown>
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return deepFreeze({ seq, type, time, data: data as JsonObject })
}

const createEventSource: FeedSourceFactory = (url) => {
  const constructor = (globalThis as { EventSource?: new (url: string) => FeedSource }).EventSource
  if (constructor === undefined) {
    throw new Error('no global EventSource: pass createSource to createSessionFeed')
  }
  return new constructor(url)
}
