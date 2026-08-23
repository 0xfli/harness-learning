/**
 * A model that is not a model.
 *
 * Every acceptance criterion for this step is about *what gets recorded*, not
 * about what the reply says, so the default adapter is a scripted one: no key,
 * no network, and the same deltas in the same order every run. Tests assert on
 * exact text because of it, and `pnpm run dev` streams something without
 * anybody having to buy tokens first.
 *
 * @module
 */

import type {
  ModelAdapter,
  ModelMessage,
  StreamChunk,
  StreamOptions,
  ToolCall,
  ToolSchema,
} from './types.ts'

/**
 * One step of a scripted reply: what to say, what to think, what to call.
 *
 * Everything is optional because every combination is a real thing a model
 * does — a tool call with no preamble, an answer with no call, and both at
 * once.
 */
export interface ScriptedStep {
  /** The reply text, streamed as deltas. */
  readonly text?: string
  /** Reasoning, streamed as its own deltas before the text. */
  readonly reasoning?: string
  /** Tools to ask for. Their ids are what the results will be matched to. */
  readonly toolCalls?: readonly ToolCall[]
}

/** What a scripted adapter says when asked. A bare string is `{ text }`. */
export type ScriptedReply = string | ScriptedStep

/** How the scripted adapter should behave. */
export interface ScriptedAdapterOptions {
  /** Name reported by the adapter. */
  readonly name?: string
  /**
   * What to reply.
   *
   * A function is called per request with the messages so far and the tools on
   * the table, which is enough for a stateless fake to drive a multi-step
   * loop: "have I already been given a tool result?" is a question about the
   * messages, so the fake never has to remember anything between requests.
   */
  readonly reply?:
    | ScriptedReply
    | ((messages: readonly ModelMessage[], tools: readonly ToolSchema[]) => ScriptedReply)
  /** Pause between deltas, in milliseconds. Zero streams as fast as it can. */
  readonly delayMs?: number
  /** Finish reason to report. */
  readonly finishReason?: string
  /** Suppress the `usage` chunk, mimicking a provider that reports none. */
  readonly reportUsage?: boolean
}

/**
 * Split text into deltas the way a provider would: small, and lossless.
 *
 * Losslessness is the property under test — the concatenation of the deltas
 * has to be the message, byte for byte, or the log is not a faithful record of
 * the stream. Splitting on words while keeping the whitespace attached is the
 * cheapest way to get that.
 *
 * @param text - the full reply.
 * @returns the pieces, in order, which concatenate back to `text`.
 */
export function splitIntoDeltas(text: string): readonly string[] {
  return text.match(/\s*\S+|\s+/g) ?? []
}

/**
 * A deterministic stand-in for a provider.
 *
 * @param options - what to say and how slowly to say it.
 * @returns an adapter that streams the scripted reply.
 */
export function createScriptedAdapter(options: ScriptedAdapterOptions = {}): ModelAdapter {
  const { name = 'scripted', delayMs = 0, finishReason = 'stop', reportUsage = true } = options
  const reply = options.reply ?? defaultReply

  return {
    name,
    async *stream(
      messages: readonly ModelMessage[],
      streamOptions: StreamOptions = {},
    ): AsyncGenerator<StreamChunk> {
      const signal = streamOptions.signal
      signal?.throwIfAborted()

      const tools = streamOptions.tools ?? []
      const step = asStep(typeof reply === 'function' ? reply(messages, tools) : reply)

      for (const delta of splitIntoDeltas(step.reasoning ?? '')) {
        if (delayMs > 0) await sleep(delayMs, signal)
        signal?.throwIfAborted()
        yield { type: 'reasoning-delta', text: delta }
      }

      const deltas = splitIntoDeltas(step.text ?? '')
      for (const delta of deltas) {
        if (delayMs > 0) await sleep(delayMs, signal)
        signal?.throwIfAborted()
        yield { type: 'text-delta', text: delta }
      }

      // After the text and before the finish, which is the order a real
      // provider streams them in.
      for (const call of step.toolCalls ?? []) {
        signal?.throwIfAborted()
        yield { type: 'tool-call', call }
      }

      const calls = step.toolCalls ?? []
      yield { type: 'finish', reason: calls.length > 0 ? 'tool_calls' : finishReason }

      if (reportUsage) {
        yield {
          type: 'usage',
          input: countWords(messages.map((message) => message.content).join(' ')),
          output: deltas.length,
        }
      }
    },
  }
}

/** A bare string is the common case, and means a step that only speaks. */
function asStep(reply: ScriptedReply): ScriptedStep {
  return typeof reply === 'string' ? { text: reply } : reply
}

/**
 * What the adapter says when nobody scripted it: enough to see the loop work.
 *
 * Three branches, in the order the loop meets them. The first fires only when
 * the message *immediately* before it is a tool result — the middle of a loop
 * — rather than whenever one appears anywhere in the history, which would mean
 * a conversation could never call a second tool after its first.
 *
 * The middle one is what makes tool calling demonstrable with no key and no
 * account, and it triggers on the tool's *name* appearing in the message
 * rather than on anything cleverer, because a fake that guesses intent is a
 * fake whose behaviour has to be learned. Type `list_directory` and it calls
 * `list_directory`.
 *
 * Arguments are taken the same way: a `{...}` anywhere in the message is used
 * verbatim as the call's arguments. Verbatim, so that typing malformed JSON
 * demonstrates what a model typing malformed JSON does, rather than being
 * quietly corrected by the fake.
 *
 * @param messages - the conversation so far.
 * @param tools - what is on the table this request.
 * @returns the step to stream.
 */
function defaultReply(
  messages: readonly ModelMessage[],
  tools: readonly ToolSchema[],
): ScriptedReply {
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    return `The tool answered, and this is that answer read back to you:\n\n${last.content}\n\nEverything above arrived as a tool/result event, and is in the log for good.`
  }

  const lastUser = messages.findLast((message) => message.role === 'user')
  const asked = lastUser?.content ?? ''
  const wanted = tools.find((tool) => asked.includes(tool.name))
  if (wanted !== undefined) {
    return {
      text: `Calling ${wanted.name}.`,
      toolCalls: [{ id: nextCallId(messages), name: wanted.name, arguments: argumentsIn(asked) }],
    }
  }

  const heard = lastUser === undefined ? 'nothing yet' : `"${asked}"`
  return `You said ${heard}. I am a scripted adapter, so this reply is the same every time — which is the point: the interesting part is that every word of it is arriving as its own event, and every one of those events is now a permanent fact in the log.`
}

/**
 * A call id no earlier call in this conversation used.
 *
 * Counted out of the history rather than held in a variable, so the adapter
 * stays a pure function of what it is handed — the same messages produce the
 * same ids, on this run and on a replay of it. Providers number theirs the
 * same way, and a repeated id would pair a result with the wrong call.
 *
 * @param messages - the conversation so far.
 * @returns `call_1`, `call_2`, and so on.
 */
function nextCallId(messages: readonly ModelMessage[]): string {
  const used = messages.filter((message) => message.role === 'tool').length
  return `call_${used + 1}`
}

/** The first `{...}` in a message, or an empty object when there is none. */
function argumentsIn(asked: string): string {
  const start = asked.indexOf('{')
  const end = asked.lastIndexOf('}')
  return start !== -1 && end > start ? asked.slice(start, end + 1) : '{}'
}

/** Words in a string, as a stand-in for tokens the scripted adapter cannot count. */
function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** A delay that gives up when the request is aborted. */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
