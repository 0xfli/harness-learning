/**
 * An adapter for the OpenAI chat-completions wire format, which most providers
 * now speak.
 *
 * `fetch` is a constructor argument rather than a global reference so the wire
 * format can be tested without a network or a key: the tests hand it a `fetch`
 * that returns a canned stream. Everything below the surface of this file is
 * "how one provider spells it"; nothing above it should have to care.
 *
 * @module
 */

import { sseDataFrames } from './sse.ts'
import { ModelStreamError } from './types.ts'
import type { ModelAdapter, ModelMessage, StreamChunk, StreamOptions } from './types.ts'

/** How to reach the provider. */
export interface OpenAiAdapterOptions {
  /** Model id, e.g. `gpt-4o-mini` or `deepseek-chat`. */
  readonly model: string
  /** Bearer token. Omit for a local server that wants none. */
  readonly apiKey?: string
  /** API root, without a trailing slash. Defaults to OpenAI's. */
  readonly baseUrl?: string
  /** Name reported by the adapter. Defaults to `openai:<model>`. */
  readonly name?: string
  /** Extra headers, e.g. a provider's organisation id. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * Build an adapter that talks to an OpenAI-compatible `/chat/completions`.
 *
 * @param options - endpoint, credentials and model.
 * @returns an adapter that streams the provider's reply as {@link StreamChunk}s.
 */
export function createOpenAiAdapter(options: OpenAiAdapterOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  const name = options.name ?? `openai:${options.model}`

  return {
    name,
    async *stream(
      messages: readonly ModelMessage[],
      streamOptions: StreamOptions = {},
    ): AsyncGenerator<StreamChunk> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...options.headers,
      }
      if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`

      const endpoint = `${baseUrl}/chat/completions`
      const request = {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          // Without this the final usage frame is simply never sent, and the
          // cost of the request is unknowable rather than merely unknown.
          stream_options: { include_usage: true },
        }),
        ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
      }

      let response: Response
      try {
        response = await doFetch(endpoint, request)
      } catch (error) {
        // An abort is the caller's own doing and must stay recognisable as
        // one; everything else is the request never leaving the building.
        if (isAbort(error)) throw error
        // `fetch failed` on its own is the least useful sentence in Node: it
        // covers a typo in the base url, a provider that is down, a name that
        // does not resolve and a machine whose only route out is a proxy. The
        // reason is in `cause`, one layer down, where nobody looks.
        throw new ModelStreamError(
          `${name} could not be reached at ${endpoint}${reasonOf(error)}`,
          {
            cause: error,
          },
        )
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new ModelStreamError(
          `${name} returned ${response.status} ${response.statusText}${detail === '' ? '' : `: ${truncate(detail)}`}`,
          { status: response.status },
        )
      }
      if (response.body === null) {
        throw new ModelStreamError(`${name} returned no body`, { status: response.status })
      }

      for await (const data of sseDataFrames(response.body)) {
        // The provider's own end-of-stream marker, which is not JSON.
        if (data === '[DONE]') return
        yield* chunksOf(data, name)
      }
    },
  }
}

/**
 * Translate one `data:` payload into zero or more chunks.
 *
 * Defensive by default: a frame whose shape is not recognised is skipped
 * rather than guessed at. A provider extending its own format is not a reason
 * to fail a request that is otherwise arriving fine.
 *
 * @param data - the raw JSON payload of one frame.
 * @param name - the adapter name, for error messages.
 * @returns the chunks that frame represents.
 */
function* chunksOf(data: string, name: string): Generator<StreamChunk> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    throw new ModelStreamError(`${name} sent a frame that is not JSON: ${truncate(data)}`, {
      cause: error,
    })
  }
  if (!isRecord(parsed)) return

  // An error delivered inside a 200 stream, which providers do when the
  // request was accepted and then went wrong.
  const error = parsed.error
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
    throw new ModelStreamError(`${name} failed mid-stream: ${message}`)
  }

  const choices = parsed.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const delta = choice.delta
      if (isRecord(delta) && typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text-delta', text: delta.content }
      }
      if (typeof choice.finish_reason === 'string') {
        yield { type: 'finish', reason: choice.finish_reason }
      }
    }
  }

  const usage = parsed.usage
  if (isRecord(usage)) {
    const input = usage.prompt_tokens
    const output = usage.completion_tokens
    if (typeof input === 'number' && typeof output === 'number') {
      yield { type: 'usage', input, output }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a rejection is the caller's own abort signal firing.
 *
 * Matched on `name` rather than `instanceof DOMException`, because the class a
 * runtime throws here is not something to depend on.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * The most specific thing that can be said about a failed connection.
 *
 * Node buries the real reason — `ENOTFOUND`, `ECONNREFUSED`, a TLS complaint —
 * in `cause`, leaving the top-level message as the word-for-word useless
 * `fetch failed`. This digs it back out so the recorded `error/stream` event
 * says something a person can act on a week later.
 *
 * @param error - whatever `fetch` rejected with.
 * @returns a `: reason` suffix, or an empty string when there is nothing to add.
 */
function reasonOf(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined
  const message = cause instanceof Error ? cause.message : undefined
  const detail = [code, message].filter((part) => part !== undefined && part.length > 0).join(': ')
  if (detail.length > 0) return `: ${truncate(detail)}`
  return error instanceof Error && error.message.length > 0 ? `: ${truncate(error.message)}` : ''
}

/** Keep a provider's prose out of the log at full length. */
function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
