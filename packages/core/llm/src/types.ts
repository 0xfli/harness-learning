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
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * A tool the model may ask for, as the provider is told about it.
 *
 * `parameters` is a JSON Schema and this package never looks inside it: the
 * schema is written by whoever wrote the tool, and every byte of it is for the
 * model. Typing it as anything narrower than "some JSON object" would be this
 * layer claiming an opinion it does not have.
 */
export interface ToolSchema {
  /** What the model calls it. Unique within a request. */
  readonly name: string
  /** What it does, in the model's only documentation. */
  readonly description: string
  /** JSON Schema for the arguments. Passed through untouched. */
  readonly parameters: Readonly<Record<string, unknown>>
}

/**
 * One request from the model to run a tool.
 *
 * `arguments` is the raw JSON *text* the provider streamed, not a parsed
 * value, and that is deliberate. It is what actually arrived — including when
 * a model emits JSON that does not parse, which happens — so recording it
 * keeps the log lossless, and parsing it exactly once, where the failure can
 * become a result, keeps the failure in one place. See `runTool` in
 * `@harness/tools`.
 */
export interface ToolCall {
  /** The provider's id for this call. What a result is matched back to. */
  readonly id: string
  /** Which tool. Not guaranteed to be one that exists. */
  readonly name: string
  /** The arguments, as JSON text. Not guaranteed to parse. */
  readonly arguments: string
}

/** Anything a human or the harness said, as a plain string. */
export interface SaidMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

/**
 * What the model said, and what it wants done about it.
 *
 * `content` and `toolCalls` are not alternatives: a model may explain itself
 * and call a tool in the same breath, and a model calling a tool with nothing
 * to say sends an empty string rather than no message at all.
 */
export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: string
  /** Present only when the model asked for a tool. */
  readonly toolCalls?: readonly ToolCall[]
  /**
   * What the model thought before it answered.
   *
   * Present only when the request that produced it carried tools, because
   * that is the only case in which a provider wants its own reasoning back —
   * see `MESSAGE_RULES` in `@harness/exchange`.
   */
  readonly reasoning?: string
}

/** What a tool said back. Always answers exactly one {@link ToolCall}. */
export interface ToolMessage {
  readonly role: 'tool'
  readonly content: string
  /** The {@link ToolCall.id} this answers. */
  readonly toolCallId: string
}

/**
 * One message in a request.
 *
 * A union rather than one shape with optional fields, for the reason given on
 * {@link StreamChunk}: `role` is already the discriminant every provider
 * writes down, so letting the compiler read it costs nothing and stops a
 * `toolCallId` from being quietly attached to a user message.
 */
export type ModelMessage = SaidMessage | AssistantMessage | ToolMessage

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
  /**
   * The model asked for a tool, with its arguments complete.
   *
   * Deliberately not streamed in pieces, and this is the one place the "every
   * delta is a fact" rule of `@harness/exchange` does not reach. A provider
   * sends a tool call's `arguments` as JSON split across frames at arbitrary
   * byte boundaries, and half of a JSON object is not a smaller fact — it is
   * not a fact at all. Nobody can render it, nobody can act on it, and the
   * only thing anybody ever does with the fragments is glue them back
   * together. Reassembling one field of a wire format is wire-format work, so
   * it happens here and the harness above is handed calls it can use.
   *
   * What is not lost by that: the assembled `arguments` reach the log verbatim
   * as a `tool/call` event, unparsed, so a malformed call is still recorded
   * exactly as the model emitted it.
   */
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  /**
   * A piece of the model's reasoning, in order.
   *
   * Deliberately not a `text-delta`. Reasoning is not part of the reply: the
   * concatenation of a reply's text deltas has to equal its message, and
   * providers reject a request that hands their own reasoning back to them.
   * Two things arriving down one socket are not therefore one thing.
   */
  | { readonly type: 'reasoning-delta'; readonly text: string }
  /** The provider stopped, and why. At most one per stream. */
  | { readonly type: 'finish'; readonly reason: string }
  /** What the request cost, as the provider counted it. */
  | { readonly type: 'usage'; readonly input: number; readonly output: number }

/** The `type` tag of any {@link StreamChunk}. */
export type StreamChunkType = StreamChunk['type']

/**
 * How hard the model should think before it answers.
 *
 * Named for what it means rather than for one vendor's spelling, because by
 * now it is not one vendor's idea: OpenAI, DeepSeek, Moonshot, MiniMax and xAI
 * all take `reasoning_effort` as a top-level string.
 *
 * The union is the documented superset, not any one provider's list, and the
 * lists genuinely differ — DeepSeek's reference gives `low | medium | high |
 * max`, Qwen's gives `low | medium | xhigh` with no `high` at all. Narrowing
 * to one of them would be picking a provider, which this package is the wrong
 * place to do. Nor would it be accurate: asked directly, `deepseek-v4-pro`
 * accepts all seven, including the three its own docs omit. So the type
 * catches a typo and the provider decides what it supports, and those are
 * different jobs done in different places.
 *
 * Matches the `openai` SDK's own `Shared.ReasoningEffort` minus `null`.
 *
 * @see https://api-docs.deepseek.com/guides/thinking_mode/
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Knobs that apply to a single request. */
export interface StreamOptions {
  /** Aborts the request. The adapter stops iterating and the socket closes. */
  readonly signal?: AbortSignal
  /**
   * The tools the model may call, sent with the request.
   *
   * Per-request rather than per-adapter because what is on the table is a
   * property of the conversation, not of the provider — and because an empty
   * list has to mean "send no `tools` field at all". A provider handed an
   * empty array is being told something different from a provider handed
   * nothing.
   */
  readonly tools?: readonly ToolSchema[]
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
