/**
 * The shapes a session log deals in: JSON payloads, and the immutable,
 * sequenced record that carries one.
 *
 * @module
 */

/** Any value that survives a JSON round-trip unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** A JSON record — the only shape an event payload may take. */
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * One fact the session knows, recorded forever.
 *
 * Every field is assigned by `SessionLog.append` and the whole record is
 * deep-frozen before anyone else can see it: an event is a ledger line, not a
 * mutable object that happens to live in an array.
 */
export interface SessionEvent<T extends string = string> {
  /** Position in the log. Zero-based, dense, and never reused. */
  readonly seq: number
  /** Namespaced kind of fact, e.g. `demo/hello`. */
  readonly type: T
  /** Wall-clock milliseconds since the epoch, read once at append time. */
  readonly time: number
  /** Deep-frozen JSON snapshot of the payload handed to `append`. */
  readonly data: JsonObject
}

/**
 * A post-commit notification. By the time an observer runs, the event is
 * already in the log — see `SessionLog.append`.
 */
export type SessionObserver = (event: SessionEvent) => void

/** Detaches an observer. Idempotent, and safe to call during dispatch. */
export type Unobserve = () => void
