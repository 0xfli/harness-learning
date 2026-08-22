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

import type { ModelAdapter, ModelMessage, StreamChunk, StreamOptions } from './types.ts'

/** How the scripted adapter should behave. */
export interface ScriptedAdapterOptions {
  /** Name reported by the adapter. */
  readonly name?: string
  /** What to reply. A function is called per request with the messages so far. */
  readonly reply?: string | ((messages: readonly ModelMessage[]) => string)
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

      const text = typeof reply === 'function' ? reply(messages) : reply
      const deltas = splitIntoDeltas(text)

      for (const delta of deltas) {
        if (delayMs > 0) await sleep(delayMs, signal)
        signal?.throwIfAborted()
        yield { type: 'text-delta', text: delta }
      }

      yield { type: 'finish', reason: finishReason }

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

/** What the adapter says when nobody scripted it: enough to see streaming work. */
function defaultReply(messages: readonly ModelMessage[]): string {
  const lastUser = messages.findLast((message) => message.role === 'user')
  const heard = lastUser === undefined ? 'nothing yet' : `"${lastUser.content}"`
  return `You said ${heard}. I am a scripted adapter, so this reply is the same every time — which is the point: the interesting part is that every word of it is arriving as its own event, and every one of those events is now a permanent fact in the log.`
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
