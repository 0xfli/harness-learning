/**
 * Running a model against the session log.
 *
 * `@harness/llm` knows how to talk to a provider; `@harness/session` knows how
 * to write things down. This package is the seam between them, and it holds
 * exactly one opinion: the streaming process is itself a fact worth recording.
 *
 * @module @harness/exchange
 */

export { recordExchange, replayChunks } from './exchange.ts'
export type { ExchangeOptions } from './exchange.ts'
export { modelMessages } from './messages.ts'
export { EXCHANGE_EVENT_TYPES } from './types.ts'
export type {
  AssistantChunkData,
  AssistantMessageData,
  AssistantUsageData,
  ExchangeResult,
  MessageId,
  StreamErrorData,
  UserMessageData,
} from './types.ts'
