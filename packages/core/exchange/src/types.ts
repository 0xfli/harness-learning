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
  /** What the request cost, as the provider counted it. */
  assistantUsage: 'assistant/usage',
  /** The assembled reply. Always the last event of a successful exchange. */
  assistantMessage: 'assistant/message',
  /** The stream did not finish. Whatever was recorded before it stays. */
  streamError: 'error/stream',
} as const

/** Identifies one reply, and every chunk that was part of it. */
export type MessageId = string

/** Payload of a `user/message` event. */
export interface UserMessageData {
  readonly id: MessageId
  readonly text: string
}

/** Payload of an `assistant/chunk` event. */
export interface AssistantChunkData {
  /** The reply this delta belongs to. */
  readonly id: MessageId
  /** Position within the reply, zero-based. Ordering without reading `seq`. */
  readonly index: number
  /** The delta itself, unmodified. */
  readonly text: string
}

/** Payload of an `assistant/usage` event. */
export interface AssistantUsageData {
  readonly id: MessageId
  readonly input: number
  readonly output: number
}

/** Payload of an `assistant/message` event. */
export interface AssistantMessageData {
  readonly id: MessageId
  /** The concatenation of every delta. */
  readonly text: string
  /** Why the provider stopped, or `unknown` when it never said. */
  readonly reason: string
  /** How many deltas were recorded, so a reader can check the run is complete. */
  readonly chunks: number
}

/** Payload of an `error/stream` event. */
export interface StreamErrorData {
  readonly id: MessageId
  readonly message: string
  /** Deltas recorded before the failure. They remain valid facts. */
  readonly chunks: number
}

/** What a completed exchange produced. */
export interface ExchangeResult {
  /** Shared by the `user/message` and every `assistant/*` event of this turn. */
  readonly id: MessageId
  /** The committed `user/message` event. */
  readonly userMessage: SessionEvent
  /** The committed `assistant/message` event. */
  readonly assistantMessage: SessionEvent
  /** The assembled reply text. */
  readonly text: string
  /** Why the provider stopped. */
  readonly reason: string
  /** Number of deltas recorded. */
  readonly chunks: number
  /** Provider-reported usage, when it reported any. */
  readonly usage: { readonly input: number; readonly output: number } | undefined
}
