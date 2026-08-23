/**
 * Running a model against the session log.
 *
 * `@harness/llm` knows how to talk to a provider; `@harness/session` knows how
 * to write things down. This package is the seam between them, and it holds
 * exactly one opinion: the streaming process is itself a fact worth recording.
 *
 * @module @harness/exchange
 */

export { DEFAULT_MAX_STEPS, recordExchange, replayChunks } from './exchange.ts'
export type { ExchangeOptions } from './exchange.ts'
export { deriveMessages, MESSAGE_RULES } from './messages.ts'
export type { MessageRule } from './messages.ts'
// The vocabulary of what a model is shown. Re-exported because it is the
// return type of `deriveMessages`, so anything that reads the projection — the
// inspector's right-hand column, above all — needs the words for it without
// taking a dependency on the provider adapters.
export type {
  AssistantMessage,
  MessageRole,
  ModelMessage,
  SaidMessage,
  ToolCall,
  ToolMessage,
} from '@harness/llm'
export { EXCHANGE_EVENT_TYPES } from './types.ts'
export type {
  AssistantChunkData,
  AssistantMessageData,
  AssistantReasoningData,
  AssistantUsageData,
  ExchangeResult,
  LoggedToolCall,
  MessageId,
  StepIndex,
  StepLimitData,
  StreamErrorData,
  ToolCallData,
  ToolResultData,
  UserMessageData,
} from './types.ts'
