/**
 * The shapes the feed client deals in: the store contract it exposes upwards,
 * and the sliver of `EventSource` it needs downwards.
 *
 * @module
 */

/**
 * A value that can be read now and watched for changes — exactly the pair
 * `useSyncExternalStore` asks for, written without importing React.
 *
 * The contract that matters is on {@link getSnapshot}: it must return the same
 * reference until the data actually changes. A store that allocates on every
 * read tells its reader "everything changed" forever.
 */
export interface ExternalStore<T> {
  /**
   * Watch for changes.
   *
   * @param listener - called after every change, with no arguments; the
   *   listener is expected to re-read {@link getSnapshot}.
   * @returns a function that detaches the listener.
   */
  subscribe(listener: () => void): () => void
  /** The current value. Stable by reference until it genuinely changes. */
  getSnapshot(): T
}

/**
 * Where the connection is, as far as the client can tell.
 *
 * - `connecting` — opening for the first time, nothing received yet.
 * - `open` — the stream is live.
 * - `reconnecting` — the socket dropped; `EventSource` is retrying, and will
 *   resume from the last `seq` it saw.
 * - `closed` — {@link SessionFeed.close} was called. Terminal.
 */
export type FeedStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** What arrives on a `message`: one SSE frame's `data` payload. */
export interface FeedSourceMessage {
  readonly data?: unknown
}

/**
 * The part of `EventSource` this package uses.
 *
 * Declared structurally rather than imported from the DOM lib so the client is
 * testable in Node with a fake, and so nothing here needs a browser to
 * typecheck.
 */
export interface FeedSource {
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: FeedSourceMessage) => void): void
  close(): void
}

/**
 * Opens a transport for one feed URL.
 *
 * A fresh source starts with no `Last-Event-ID`, which is what makes
 * "reconnect from scratch" possible: see the resync path in `session-feed.ts`.
 */
export type FeedSourceFactory = (url: string) => FeedSource

/** Why the feed client is complaining. */
export type FeedErrorReason =
  /** A frame's payload was not JSON, or not a well-formed event. */
  | 'malformed-frame'
  /** An event arrived ahead of its position, which would leave a hole. */
  | 'gap'
  /** A position we already hold came back with different content. */
  | 'divergence'
  /** A subscriber threw while being notified. */
  | 'listener'

/** A problem the feed client contained rather than propagated. */
export interface FeedError {
  readonly reason: FeedErrorReason
  readonly message: string
  /** The underlying failure, when there was one. */
  readonly cause?: unknown
}
