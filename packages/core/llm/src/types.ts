/**
 * What a model adapter is, and what it streams.
 *
 * Nothing here knows about the session log. An adapter's whole job is to turn
 * one provider's wire format into this vocabulary; deciding what is worth
 * recording is somebody else's.
 *
 * @module
 */

/** Who said it. */
export type MessageRole = 'system' | 'user' | 'assistant'

/**
 * One message in a request.
 *
 * Content is a plain string for now. Content blocks — reasoning, images, tool
 * calls — are a later step; the union below is where they will arrive.
 */
export interface ModelMessage {
  readonly role: MessageRole
  readonly content: string
}

/**
 * One thing that happened while the model was replying.
 *
 * A discriminated union rather than one object with every field optional. The
 * difference shows up when a new chunk kind arrives: a union grows a member
 * and every exhaustive `switch` stops compiling until it is handled, whereas
 * an optional-field bag grows a field and every reader silently ignores it.
 * The compiler is the only reviewer that reads every call site.
 */
export type StreamChunk =
  /** A piece of the reply text, in order. Concatenating these is the message. */
  | { readonly type: 'text-delta'; readonly text: string }
  /** The provider stopped, and why. At most one per stream. */
  | { readonly type: 'finish'; readonly reason: string }
  /** What the request cost, as the provider counted it. */
  | { readonly type: 'usage'; readonly input: number; readonly output: number }

/** The `type` tag of any {@link StreamChunk}. */
export type StreamChunkType = StreamChunk['type']

/** Knobs that apply to a single request. */
export interface StreamOptions {
  /** Aborts the request. The adapter stops iterating and the socket closes. */
  readonly signal?: AbortSignal
}

/**
 * A model, reduced to the one thing the harness needs from it.
 *
 * Returning an `AsyncIterable` rather than taking an `onChunk` callback is
 * deliberate: the caller keeps control of the loop, so back-pressure,
 * early exit and error propagation are all just `for await` semantics rather
 * than a protocol invented per adapter.
 */
export interface ModelAdapter {
  /** Identifies the adapter in logs and in the inspector. */
  readonly name: string
  /**
   * Send a request and stream the reply.
   *
   * @param messages - the conversation so far, oldest first.
   * @param options - per-request knobs, notably an abort signal.
   * @returns the chunks the provider emitted, in order.
   */
  stream(messages: readonly ModelMessage[], options?: StreamOptions): AsyncIterable<StreamChunk>
}

/**
 * A provider failed, on the wire or in its own words.
 *
 * Carries the status when there was one, so a retry policy can tell "the
 * provider is overloaded" from "the request was malformed" without parsing
 * prose. Nothing retries yet; the fact is recorded for when something does.
 */
export class ModelStreamError extends Error {
  /** HTTP status the provider returned, when the failure had one. */
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelStreamError'
    this.status = options.status
  }
}
