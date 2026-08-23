/**
 * The shapes an exchange deals in: the event payloads it writes, and the
 * summary it hands back.
 *
 * The payload types are exported because they are a contract, not an
 * implementation detail — the inspector, the conversation projection and every
 * later step read these events, and a payload that changes shape silently is a
 * renderer that silently stops working.
 *
 * @module
 */

import type { SessionEvent } from '@harness/session'

/** Event types an exchange writes. Nothing else may write them. */
export const EXCHANGE_EVENT_TYPES = {
  /** What the human said. */
  userMessage: 'user/message',
  /** One delta, exactly as the provider emitted it. */
  assistantChunk: 'assistant/chunk',
  /**
   * One reasoning delta. Logged for the human, never replayed to the model.
   *
   * The first event type that is deliberately both: visible in the inspector,
   * absent from `MESSAGE_RULES`. Providers reject a request that hands their
   * own reasoning back to them, and it is not something anybody said.
   */
  assistantReasoning: 'assistant/reasoning',
  /** What the request cost, as the provider counted it. */
  assistantUsage: 'assistant/usage',
  /** The assembled reply. Always the last event of a successful step. */
  assistantMessage: 'assistant/message',
  /**
   * The model asked for a tool, and the harness is about to run it.
   *
   * Not the same fact as the `toolCalls` on the `assistant/message` that
   * carries it, though they describe the same call — that one is what the
   * model *said*, this one is what the harness is *doing about it*, and it is
   * the half a `tool/result` pairs with. Deliberately has no entry in
   * `MESSAGE_RULES`: replaying it would show the model its own request twice.
   */
  toolCall: 'tool/call',
  /**
   * What the tool said back — including when what it said is that it failed.
   *
   * Exactly one of these follows every `tool/call`, always, and the log is
   * wrong if that is ever untrue. See
   * `docs/adr/0011-a-failing-tool-is-a-result.md`.
   */
  toolResult: 'tool/result',
  /** The stream did not finish. Whatever was recorded before it stays. */
  streamError: 'error/stream',
  /**
   * The loop hit its step limit and stopped on purpose.
   *
   * A model that answers every tool result with another tool call is not
   * broken and not rare, and left alone it spends money in a circle. The limit
   * is recorded rather than merely enforced, because "why did it stop there?"
   * is a question the log should answer.
   */
  stepLimit: 'error/steps',
} as const

/** Identifies one reply, and every chunk that was part of it. */
export type MessageId = string

/**
 * Which model request within one exchange an event belongs to.
 *
 * Zero-based. A **step** is one request plus the tools it called, and an
 * exchange is now one or more of them: the model asks for a directory listing
 * in step 0 and answers from it in step 1. The **message id** still names the
 * exchange, so `id` alone no longer separates two assistant replies — anything
 * that groups by reply has to group by `id` *and* `step`.
 *
 * A first-class state machine for this is the next step's job. This is the
 * number it will be built out of.
 */
export type StepIndex = number

/** Payload of a `user/message` event. */
export interface UserMessageData {
  readonly id: MessageId
  readonly text: string
}

/** Payload of an `assistant/chunk` event. */
export interface AssistantChunkData {
  /** The reply this delta belongs to. */
  readonly id: MessageId
  /** Which request within the exchange produced it. */
  readonly step: StepIndex
  /** Position within the reply, zero-based. Ordering without reading `seq`. */
  readonly index: number
  /** The delta itself, unmodified. */
  readonly text: string
}

/**
 * Payload of an `assistant/reasoning` event.
 *
 * The same shape as {@link AssistantChunkData} and deliberately a separate
 * type: they are counted separately, so `index` means "the nth reasoning
 * delta", not "the nth delta". A reader that conflates them gets an ordering
 * that looks right and is not.
 */
export interface AssistantReasoningData {
  /** The reply this reasoning belongs to. */
  readonly id: MessageId
  /** Which request within the exchange produced it. */
  readonly step: StepIndex
  /** Position within the reasoning, zero-based. */
  readonly index: number
  /** The delta itself, unmodified. */
  readonly text: string
}

/** Payload of an `assistant/usage` event. */
export interface AssistantUsageData {
  readonly id: MessageId
  readonly step: StepIndex
  readonly input: number
  readonly output: number
}

/** One call, as it is written down. Mirrors `ToolCall` from `@harness/llm`. */
export interface LoggedToolCall {
  /** The provider's id for the call. What the result is matched back to. */
  readonly id: string
  readonly name: string
  /** The arguments as JSON text, exactly as the provider streamed them. */
  readonly arguments: string
}

/** Payload of an `assistant/message` event. */
export interface AssistantMessageData {
  readonly id: MessageId
  readonly step: StepIndex
  /** The concatenation of every delta. */
  readonly text: string
  /** Why the provider stopped, or `unknown` when it never said. */
  readonly reason: string
  /** How many deltas were recorded, so a reader can check the run is complete. */
  readonly chunks: number
  /** How many reasoning deltas were recorded. Zero for a model that shows none. */
  readonly reasoningChunks: number
  /** What the model asked to run. Empty when it asked for nothing. */
  readonly toolCalls: readonly LoggedToolCall[]
  /**
   * The assembled reasoning — but only when the request carried tools.
   *
   * Empty otherwise, and the emptiness is the decision rather than an
   * omission. A provider that was given tools requires its own reasoning back
   * on the next request; a provider that was not, rejects it. The recorder
   * knows which request it made, so it decides here, once, and
   * `MESSAGE_RULES` stays a plain per-event map that replays whatever it
   * finds. See `messages.ts`.
   */
  readonly reasoning: string
}

/** Payload of a `tool/call` event. */
export interface ToolCallData {
  /** The exchange this call belongs to. */
  readonly id: MessageId
  /** Which request asked for it. */
  readonly step: StepIndex
  /** The provider's call id. Unique within the exchange, and the pairing key. */
  readonly callId: string
  readonly name: string
  /** The arguments as JSON text, unparsed. Not guaranteed to be valid JSON. */
  readonly arguments: string
}

/** Payload of a `tool/result` event. */
export interface ToolResultData {
  readonly id: MessageId
  readonly step: StepIndex
  /** The {@link ToolCallData.callId} this answers. Exactly one result per call. */
  readonly callId: string
  readonly name: string
  /** What the model is told. */
  readonly content: string
  /** Whether that content is a failure. A failure is still a result. */
  readonly isError: boolean
}

/** Payload of an `error/stream` event. */
export interface StreamErrorData {
  readonly id: MessageId
  readonly step: StepIndex
  readonly message: string
  /** Deltas recorded before the failure. They remain valid facts. */
  readonly chunks: number
}

/** Payload of an `error/steps` event. */
export interface StepLimitData {
  readonly id: MessageId
  /** The step that would have run next, and did not. */
  readonly step: StepIndex
  /** The limit that stopped it. */
  readonly limit: number
  readonly message: string
}

/** What a completed exchange produced. */
export interface ExchangeResult {
  /** Shared by every event of this exchange, across every step. */
  readonly id: MessageId
  /** The committed `user/message` event. */
  readonly userMessage: SessionEvent
  /** The last step's committed `assistant/message` event. */
  readonly assistantMessage: SessionEvent
  /** The last step's assembled reply text — the answer the human reads. */
  readonly text: string
  /** Why the provider stopped, on the last step. */
  readonly reason: string
  /** Deltas recorded on the last step. */
  readonly chunks: number
  /** Reasoning deltas recorded on the last step. */
  readonly reasoningChunks: number
  /** How many model requests the exchange took. At least one. */
  readonly steps: number
  /** How many tools were run across every step. */
  readonly toolCalls: number
  /** Whether the loop stopped because it hit the step limit. */
  readonly stoppedAtLimit: boolean
  /** Provider-reported usage on the last step, when it reported any. */
  readonly usage: { readonly input: number; readonly output: number } | undefined
}
