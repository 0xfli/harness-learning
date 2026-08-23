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
 * Since tools arrived, an exchange is a *loop*. One **step** is one request
 * plus the tools it called; an exchange runs steps until one of them asks for
 * nothing. The loop itself is a handful of lines and the care is all in one
 * place: a `tool/call` and its `tool/result` are appended as a pair, and
 * nothing between them is allowed to throw. See {@link runCalls}.
 *
 * @module
 */

import type { SessionEvent, SessionLog } from '@harness/session'
import type { ModelAdapter, ModelMessage, ToolCall, ToolSchema } from '@harness/llm'
import { EMPTY_TOOL_REGISTRY, runTool } from '@harness/tools'
import type { ToolRegistry } from '@harness/tools'
import { deriveMessages } from './messages.ts'
import { EXCHANGE_EVENT_TYPES } from './types.ts'
import type { ExchangeResult, MessageId, StepIndex } from './types.ts'

/** What to run, and against what. */
export interface ExchangeOptions {
  /** Where the facts go. */
  readonly log: SessionLog
  /** Who to ask. */
  readonly adapter: ModelAdapter
  /** What the human said. */
  readonly text: string
  /**
   * What the model may call. Defaults to nothing, which makes an exchange
   * exactly what it was before this step: one request, one reply.
   */
  readonly tools?: ToolRegistry
  /** Abort the request. Whatever was recorded before the abort stays recorded. */
  readonly signal?: AbortSignal
  /**
   * Most model requests one exchange may make. Defaults to
   * {@link DEFAULT_MAX_STEPS}.
   *
   * A ceiling, not a plan: a model that answers every result with another call
   * is a normal failure mode, and without a limit it is an expensive one.
   */
  readonly maxSteps?: number
  /** Identifier factory, injected so tests can assert on exact payloads. */
  readonly newId?: () => MessageId
}

/** Reported when the provider streamed no finish reason. */
const UNKNOWN_REASON = 'unknown'

/**
 * How many requests one exchange may make before the loop gives up.
 *
 * Enough for a model to look something up, look up what that pointed at, and
 * answer; small enough that a runaway loop costs pennies rather than an
 * afternoon.
 */
export const DEFAULT_MAX_STEPS = 8

/** What one step of the loop produced. */
interface StepResult {
  readonly assistantMessage: SessionEvent
  readonly text: string
  readonly reason: string
  readonly chunks: number
  readonly reasoningChunks: number
  /** What the model wants run before the next step. Empty ends the loop. */
  readonly calls: readonly ToolCall[]
  readonly usage: { readonly input: number; readonly output: number } | undefined
}

/**
 * Record one exchange from end to end.
 *
 * The order of appends is the contract:
 *
 * 1. `user/message` — once, before the first request, because every request is
 *    built by reading the log back.
 * 2. per step: `assistant/chunk` and `assistant/reasoning` as they arrive,
 *    `assistant/usage` when the provider reports it, then `assistant/message`.
 * 3. per call that step asked for, in the order it asked: `tool/call`, then
 *    exactly one `tool/result`.
 * 4. repeat, until a step asks for no tools.
 *
 * `assistant/message` is still last within its step, and its presence is still
 * what "this reply is complete" means. What changed is that an exchange may
 * hold several of them, one per step, told apart by `step`.
 *
 * @param options - the log, the adapter, the tools, and what to say.
 * @returns a summary of what was recorded.
 * @throws whatever the adapter threw, after recording `error/stream`. A tool
 *   never throws — see `runTool` in `@harness/tools`.
 */
export async function recordExchange(options: ExchangeOptions): Promise<ExchangeResult> {
  const { log, adapter, text, signal } = options
  const tools = options.tools ?? EMPTY_TOOL_REGISTRY
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const newId = options.newId ?? defaultNewId

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('exchange text must be a non-empty string')
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError('maxSteps must be a positive integer')
  }

  const id = newId()
  const userMessage = log.append(EXCHANGE_EVENT_TYPES.userMessage, { id, text })

  const schemas = tools.schemas()
  let step: StepIndex = 0
  let toolCalls = 0
  let last: StepResult

  for (;;) {
    // Read the history back out of the log rather than threading it through.
    // The log is the source of truth even for the request that is about to be
    // made from it, and this line is the only place a request comes from —
    // recomputed per step, never carried between them. Which is also the whole
    // mechanism of the loop: the tool results appended below are in the log, so
    // the next step sees them without anybody having to pass them along.
    const messages = deriveMessages(log)
    last = await runStep({ log, adapter, id, step, messages, schemas, signal })

    if (last.calls.length === 0) {
      return summarise({ id, userMessage, last, steps: step + 1, toolCalls, stoppedAtLimit: false })
    }

    toolCalls += await runCalls({ log, tools, id, step, calls: last.calls, signal })

    step += 1
    if (step >= maxSteps) {
      const message = `stopped after ${maxSteps} steps without a final answer`
      log.append(EXCHANGE_EVENT_TYPES.stepLimit, { id, step, limit: maxSteps, message })
      return summarise({ id, userMessage, last, steps: step, toolCalls, stoppedAtLimit: true })
    }
  }
}

/** Everything one model request needs. */
interface StepOptions {
  readonly log: SessionLog
  readonly adapter: ModelAdapter
  readonly id: MessageId
  readonly step: StepIndex
  readonly messages: readonly ModelMessage[]
  readonly schemas: readonly ToolSchema[]
  readonly signal: AbortSignal | undefined
}

/**
 * One request, streamed and written down.
 *
 * @param options - what to ask, and where to record the answer.
 * @returns what the step produced, including what it wants run.
 * @throws whatever the adapter threw, after recording `error/stream`.
 */
async function runStep(options: StepOptions): Promise<StepResult> {
  const { log, adapter, id, step, messages, schemas, signal } = options

  const deltas: string[] = []
  const reasoning: string[] = []
  const calls: ToolCall[] = []
  let reason = UNKNOWN_REASON
  let usage: { input: number; output: number } | undefined

  try {
    for await (const chunk of adapter.stream(messages, {
      ...(signal === undefined ? {} : { signal }),
      // An empty list means "send no tools at all", which the adapter honours
      // and which the reasoning decision below depends on.
      ...(schemas.length === 0 ? {} : { tools: schemas }),
    })) {
      switch (chunk.type) {
        case 'text-delta':
          log.append(EXCHANGE_EVENT_TYPES.assistantChunk, {
            id,
            step,
            index: deltas.length,
            text: chunk.text,
          })
          deltas.push(chunk.text)
          break

        case 'reasoning-delta':
          // Its own event, its own counter. Recorded exactly as it streamed,
          // and — see `MESSAGE_RULES` — sent back only when tools are in play.
          log.append(EXCHANGE_EVENT_TYPES.assistantReasoning, {
            id,
            step,
            index: reasoning.length,
            text: chunk.text,
          })
          reasoning.push(chunk.text)
          break

        case 'tool-call':
          // Held, not appended. A `tool/call` event is a promise that a
          // `tool/result` follows it, and that promise must not be made while
          // the stream is still open and still able to fail.
          calls.push(chunk.call)
          break

        case 'finish':
          // Not an event of its own: the reason belongs on the message it
          // describes, and one fact recorded twice is one fact that can
          // disagree with itself.
          reason = chunk.reason
          break

        case 'usage':
          usage = { input: chunk.input, output: chunk.output }
          log.append(EXCHANGE_EVENT_TYPES.assistantUsage, { id, step, ...usage })
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
      step,
      message: error instanceof Error ? error.message : String(error),
      chunks: deltas.length,
    })
    throw error
  }

  const assembled = deltas.join('')
  const assistantMessage = log.append(EXCHANGE_EVENT_TYPES.assistantMessage, {
    id,
    step,
    text: assembled,
    reason,
    chunks: deltas.length,
    reasoningChunks: reasoning.length,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    // Decided here, where the request that was actually made is known, rather
    // than in the projection, which cannot know. See
    // `AssistantMessageData.reasoning`.
    reasoning: schemas.length === 0 ? '' : reasoning.join(''),
  })

  return {
    assistantMessage,
    text: assembled,
    reason,
    chunks: deltas.length,
    reasoningChunks: reasoning.length,
    calls: Object.freeze(calls),
    usage,
  }
}

/** Everything running one step's calls needs. */
interface CallsOptions {
  readonly log: SessionLog
  readonly tools: ToolRegistry
  readonly id: MessageId
  readonly step: StepIndex
  readonly calls: readonly ToolCall[]
  readonly signal: AbortSignal | undefined
}

/**
 * Run every call the step asked for, in the order it asked.
 *
 * The lesson of this step is in the shape of this loop rather than in anything
 * it says. There is no `try` here and there does not need to be: `runTool` is
 * documented as never rejecting, so the `tool/result` on the line after the
 * `tool/call` is unconditional. Balance is not something this function checks
 * afterwards — it is something it cannot fail to produce.
 *
 * Sequentially, deliberately. Running them at once is a real thing a harness
 * should do and it is a step of its own, because the moment two tools run
 * together "the log is in the order things happened" stops being free.
 *
 * @param options - the calls, the tools, and where the results go.
 * @returns how many calls were run.
 */
async function runCalls(options: CallsOptions): Promise<number> {
  const { log, tools, id, step, calls, signal } = options

  for (const call of calls) {
    log.append(EXCHANGE_EVENT_TYPES.toolCall, {
      id,
      step,
      callId: call.id,
      name: call.name,
      // Verbatim, unparsed. A model that emitted malformed JSON emitted it,
      // and the log records what happened rather than what would have been
      // convenient.
      arguments: call.arguments,
    })

    const result = await runTool(tools, call, signal === undefined ? {} : { signal })

    log.append(EXCHANGE_EVENT_TYPES.toolResult, {
      id,
      step,
      callId: call.id,
      name: call.name,
      content: result.content,
      isError: result.isError,
    })
  }

  return calls.length
}

/** Fold the loop's bookkeeping into what a caller was promised. */
function summarise(parts: {
  readonly id: MessageId
  readonly userMessage: SessionEvent
  readonly last: StepResult
  readonly steps: number
  readonly toolCalls: number
  readonly stoppedAtLimit: boolean
}): ExchangeResult {
  return {
    id: parts.id,
    userMessage: parts.userMessage,
    assistantMessage: parts.last.assistantMessage,
    text: parts.last.text,
    reason: parts.last.reason,
    chunks: parts.last.chunks,
    reasoningChunks: parts.last.reasoningChunks,
    steps: parts.steps,
    toolCalls: parts.toolCalls,
    stoppedAtLimit: parts.stoppedAtLimit,
    usage: parts.last.usage,
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
 * @param id - the exchange to reassemble.
 * @param step - which step's reply. Omitted, every step's deltas are
 *   concatenated — which is the text of the whole exchange rather than of any
 *   one reply.
 * @returns the concatenated deltas, which equal the assembled message text.
 */
export function replayChunks(
  events: readonly SessionEvent[],
  id: MessageId,
  step?: StepIndex,
): string {
  return events
    .filter(
      (event) =>
        event.type === EXCHANGE_EVENT_TYPES.assistantChunk &&
        event.data['id'] === id &&
        (step === undefined || event.data['step'] === step),
    )
    .map((event) => (typeof event.data['text'] === 'string' ? event.data['text'] : ''))
    .join('')
}

/** Ids only have to be unique within a log; `randomUUID` is more than enough. */
function defaultNewId(): MessageId {
  return globalThis.crypto.randomUUID()
}
