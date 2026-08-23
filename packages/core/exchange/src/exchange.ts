/**
 * One exchange: the human says something, the model replies, and the whole
 * reply — not just its conclusion — is written down.
 *
 * The temptation this module exists to resist is a single line:
 *
 * ```ts
 * for await (const chunk of stream) text += chunk.text
 * log.append('assistant/message', { text })
 * ```
 *
 * That renders identically and records almost nothing. Reload the page and the
 * reply is there, but *how it arrived* is gone: no order, no timing, no
 * partial state to reason about. You cannot debug a stream you did not
 * record, and every question worth asking about streaming — did it stall, did
 * it arrive out of order, what had we shown the user when it failed — is a
 * question about the process. So every delta is an event, and the assembled
 * message is a summary of events that already exist rather than the only trace
 * that anything happened.
 *
 * @module
 */

import type { SessionEvent, SessionLog } from '@harness/session'
import type { ModelAdapter } from '@harness/llm'
import { deriveMessages } from './messages.ts'
import { EXCHANGE_EVENT_TYPES } from './types.ts'
import type { ExchangeResult, MessageId } from './types.ts'

/** What to run, and against what. */
export interface ExchangeOptions {
  /** Where the facts go. */
  readonly log: SessionLog
  /** Who to ask. */
  readonly adapter: ModelAdapter
  /** What the human said. */
  readonly text: string
  /** Abort the request. Whatever was recorded before the abort stays recorded. */
  readonly signal?: AbortSignal
  /** Identifier factory, injected so tests can assert on exact payloads. */
  readonly newId?: () => MessageId
}

/** Reported when the provider streamed no finish reason. */
const UNKNOWN_REASON = 'unknown'

/**
 * Record one exchange from end to end.
 *
 * The order of appends is the contract:
 *
 * 1. `user/message` — before the request, because the request is built by
 *    reading the log back.
 * 2. `assistant/chunk` — one per delta, as it arrives.
 * 3. `assistant/usage` — when the provider reports it, which is before it
 *    hangs up.
 * 4. `assistant/message` — last, always. Its presence is what "the reply is
 *    complete" means; anything reading the log can rely on that rather than
 *    inferring completeness from a gap in time.
 *
 * @param options - the log, the adapter, and what to say.
 * @returns a summary of what was recorded.
 * @throws whatever the adapter threw, after recording `error/stream`.
 */
export async function recordExchange(options: ExchangeOptions): Promise<ExchangeResult> {
  const { log, adapter, text, signal } = options
  const newId = options.newId ?? defaultNewId

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('exchange text must be a non-empty string')
  }

  const id = newId()
  const userMessage = log.append(EXCHANGE_EVENT_TYPES.userMessage, { id, text })

  // Read the history back out of the log rather than threading `text` through.
  // The log is the source of truth even for the request that is about to be
  // made from it, and this line is the only place the request comes from —
  // recomputed per request, never carried between them.
  const messages = deriveMessages(log)

  const deltas: string[] = []
  const reasoning: string[] = []
  let reason = UNKNOWN_REASON
  let usage: { input: number; output: number } | undefined

  try {
    for await (const chunk of adapter.stream(messages, signal === undefined ? {} : { signal })) {
      switch (chunk.type) {
        case 'text-delta':
          log.append(EXCHANGE_EVENT_TYPES.assistantChunk, {
            id,
            index: deltas.length,
            text: chunk.text,
          })
          deltas.push(chunk.text)
          break

        case 'reasoning-delta':
          // Its own event, its own counter. Recorded exactly as it streamed,
          // and — see `MESSAGE_RULES` — never sent back.
          log.append(EXCHANGE_EVENT_TYPES.assistantReasoning, {
            id,
            index: reasoning.length,
            text: chunk.text,
          })
          reasoning.push(chunk.text)
          break

        case 'finish':
          // Not an event of its own: the reason belongs on the message it
          // describes, and one fact recorded twice is one fact that can
          // disagree with itself.
          reason = chunk.reason
          break

        case 'usage':
          usage = { input: chunk.input, output: chunk.output }
          log.append(EXCHANGE_EVENT_TYPES.assistantUsage, { id, ...usage })
          break

        default:
          // The union is exhaustive today. When a provider grows a chunk kind,
          // this is the line the compiler points at.
          throw new TypeError(`unhandled stream chunk: ${JSON.stringify(chunk)}`)
      }
    }
  } catch (error) {
    log.append(EXCHANGE_EVENT_TYPES.streamError, {
      id,
      message: error instanceof Error ? error.message : String(error),
      chunks: deltas.length,
    })
    throw error
  }

  const assembled = deltas.join('')
  const assistantMessage = log.append(EXCHANGE_EVENT_TYPES.assistantMessage, {
    id,
    text: assembled,
    reason,
    chunks: deltas.length,
    reasoningChunks: reasoning.length,
  })

  return {
    id,
    userMessage,
    assistantMessage,
    text: assembled,
    reason,
    chunks: deltas.length,
    reasoningChunks: reasoning.length,
    usage,
  }
}

/**
 * Reassemble a reply from the chunks in the log.
 *
 * The inverse of what {@link recordExchange} wrote, and the reason the deltas
 * are worth keeping: this works on a log loaded from disk, in a test, or in a
 * console — anywhere, long after the socket closed.
 *
 * @param events - the log, or any slice of it.
 * @param id - the reply to reassemble.
 * @returns the concatenated deltas, which equal the assembled message text.
 */
export function replayChunks(events: readonly SessionEvent[], id: MessageId): string {
  return events
    .filter((event) => event.type === EXCHANGE_EVENT_TYPES.assistantChunk && event.data.id === id)
    .map((event) => (typeof event.data.text === 'string' ? event.data.text : ''))
    .join('')
}

/** Ids only have to be unique within a log; `randomUUID` is more than enough. */
function defaultNewId(): MessageId {
  return globalThis.crypto.randomUUID()
}
