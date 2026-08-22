/**
 * An adapter for the OpenAI chat-completions wire format, which most providers
 * now speak.
 *
 * The `openai` package does the wire work — request shaping, SSE reassembly,
 * frame parsing — and this module does the part that is ours: turning one
 * provider's vocabulary into {@link StreamChunk}, and its failures into
 * {@link ModelStreamError}. The SDK stops at the edge of this file. Nothing
 * above it imports `openai`, so "which provider, spelled how" stays a fact
 * about one module rather than a type that leaks into the session log.
 *
 * `fetch` is a constructor argument rather than a global reference so the wire
 * format can be tested without a network or a key: the tests hand it a `fetch`
 * that returns a canned stream. Reaching a provider through a proxy is the
 * runtime's job, not this module's — see `NODE_USE_ENV_PROXY` in the README.
 *
 * @module
 */

import { APIError, APIUserAbortError, OpenAI } from 'openai'
import { ModelStreamError } from './types.ts'
import type {
  ModelAdapter,
  ModelMessage,
  ReasoningEffort,
  StreamChunk,
  StreamOptions,
} from './types.ts'
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions'
import type { StreamedDelta } from './openai-extensions.ts'

/** How to reach the provider. */
export interface OpenAiAdapterOptions {
  /** Model id, e.g. `gpt-4o-mini` or `deepseek-v4-pro`. */
  readonly model: string
  /** ****** Omit for a local server that wants none. */
  readonly apiKey?: string
  /** API root, without a trailing slash. Defaults to OpenAI's. */
  readonly baseUrl?: string
  /** Name reported by the adapter. Defaults to `openai:<model>`. */
  readonly name?: string
  /** Extra headers, e.g. a provider's organisation id. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injected so tests can stub the wire. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /**
   * How hard to think, sent as `reasoning_effort`.
   *
   * Omitted when unset, because a model that does not reason rejects the field
   * rather than ignoring it.
   */
  readonly reasoning?: ReasoningEffort
  /**
   * Whether to reason at all, in DeepSeek's spelling.
   *
   * Separate from {@link reasoning} because they are separate questions whose
   * answers do not imply each other: `deepseek-v4-pro` reasons by default, so
   * `disabled` is the value that changes anything, while `reasoning_effort`
   * turns the dial without touching the switch.
   */
  readonly thinking?: 'enabled' | 'disabled'
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Stands in for the key the SDK insists on and a keyless provider does not want. */
const NO_KEY = 'no-key'

/**
 * Build an adapter that talks to an OpenAI-compatible `/chat/completions`.
 *
 * @param options - endpoint, credentials and model.
 * @returns an adapter that streams the provider's reply as {@link StreamChunk}s.
 */
export function createOpenAiAdapter(options: OpenAiAdapterOptions): ModelAdapter {
  const baseURL = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const endpoint = `${baseURL}/chat/completions`
  const name = options.name ?? `openai:${options.model}`

  const client = new OpenAI({
    baseURL,
    // A local provider legitimately wants no `authorization` header at all,
    // but the SDK refuses to construct without a key — an empty string
    // included. So it gets a placeholder it will never send: the `null`
    // default header below is how the SDK is told to omit the header outright,
    // rather than send `Bearer` followed by nothing.
    apiKey: options.apiKey ?? NO_KEY,
    defaultHeaders: {
      ...(options.apiKey === undefined ? { authorization: null } : {}),
      ...options.headers,
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // Retrying is a policy decision with a step of its own, and one the log has
    // to be able to see. Left at its default, the SDK would quietly turn one
    // recorded request into three real ones and the journal would show the last
    // of them as though it had been the only one.
    maxRetries: 0,
  })

  return {
    name,
    async *stream(
      messages: readonly ModelMessage[],
      streamOptions: StreamOptions = {},
    ): AsyncGenerator<StreamChunk> {
      const body: ChatCompletionCreateParamsStreaming = {
        model: options.model,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        // Without this the final usage frame is simply never sent, and the cost
        // of the request is unknowable rather than merely unknown.
        stream_options: { include_usage: true },
        ...(options.reasoning === undefined ? {} : { reasoning_effort: options.reasoning }),
        ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }),
      }

      try {
        const stream = await client.chat.completions.create(
          body,
          streamOptions.signal === undefined ? {} : { signal: streamOptions.signal },
        )
        for await (const frame of stream) yield* chunksOf(frame)
      } catch (error) {
        throw translate(error, name, endpoint)
      }
    },
  }
}

/**
 * Translate one streamed frame into zero or more chunks.
 *
 * Defensive by default: a field whose shape is not recognised is skipped
 * rather than guessed at. A provider extending its own format is not a reason
 * to fail a request that is otherwise arriving fine.
 *
 * @param frame - one `chat.completion.chunk`, as the SDK parsed it.
 * @returns the chunks that frame represents.
 */
function* chunksOf(frame: OpenAI.ChatCompletionChunk): Generator<StreamChunk> {
  for (const choice of frame.choices ?? []) {
    const delta: StreamedDelta | undefined = choice.delta

    // Reasoning first, and it genuinely does arrive first: a model that thinks
    // out loud sends every reasoning delta before its first word of reply.
    const reasoning = delta?.reasoning_content
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      yield { type: 'reasoning-delta', text: reasoning }
    }

    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      yield { type: 'text-delta', text: content }
    }

    if (typeof choice.finish_reason === 'string') {
      yield { type: 'finish', reason: choice.finish_reason }
    }
  }

  const usage = frame.usage
  if (usage !== null && usage !== undefined) {
    const input = usage.prompt_tokens
    const output = usage.completion_tokens
    if (typeof input === 'number' && typeof output === 'number') {
      yield { type: 'usage', input, output }
    }
  }
}

/**
 * Turn whatever the SDK threw into something the log can still be read from a
 * week later.
 *
 * The SDK's errors are good, but they are the SDK's: a caller that catches one
 * has to know `openai` to understand it, and the point of the adapter seam is
 * that nothing above it does.
 *
 * @param error - whatever the request or the stream rejected with.
 * @param name - the adapter name, which is what a reader recognises.
 * @param endpoint - where the request was going.
 * @returns a {@link ModelStreamError}, or the error unchanged if it was an abort.
 */
function translate(error: unknown, name: string, endpoint: string): unknown {
  // An abort is the caller's own doing and must stay recognisable as one, and
  // recognisable means the very error they can compare against — not the SDK's
  // wrapper around it. Everything else is the reply never arriving.
  const abort = abortWithin(error)
  if (abort !== undefined) return abort
  if (error instanceof ModelStreamError) return error

  if (error instanceof APIError && typeof error.status === 'number') {
    const detail = detailOf(error)
    return new ModelStreamError(
      `${name} returned ${error.status}${detail === '' ? '' : `: ${truncate(detail)}`}`,
      { status: error.status, cause: error },
    )
  }

  // `fetch failed` on its own is the least useful sentence in Node: it covers
  // a typo in the base url, a provider that is down, a name that does not
  // resolve and a machine whose only route out is a proxy. The reason is in
  // `cause`, one or two layers down, where nobody looks.
  //
  // The cause recorded is the error the runtime raised, not the SDK's wrapper
  // around it. `Connection error.` is what the wrapper adds, and it is the one
  // thing in the chain that tells a reader nothing.
  return new ModelStreamError(`${name} could not be reached at ${endpoint}${reasonOf(error)}`, {
    cause: underlying(error),
  })
}

/**
 * The error the runtime actually raised, from under the SDK's wrapper.
 *
 * @param error - whatever was thrown.
 * @returns the wrapped cause when there is one, otherwise the error itself.
 */
function underlying(error: unknown): unknown {
  if (error instanceof APIError && error.cause !== undefined) return error.cause
  return error
}

/** What the provider said about its own refusal, when it said anything. */
function detailOf(error: APIError): string {
  const body: unknown = error.error
  if (isRecord(body) && typeof body.message === 'string') return body.message
  if (typeof body === 'string') return body
  return error.message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The abort inside a rejection, if there is one anywhere in it.
 *
 * Searched down the whole chain rather than checked at the top, because the
 * SDK wraps whatever `fetch` rejected with in an error of its own, and an
 * abort inside a wrapper is still an abort. Returns the abort itself rather
 * than a boolean so the caller can be handed back the exact error it is
 * waiting to recognise: "the user navigated away" has to stay distinguishable
 * from "the provider is unreachable", and identity is how a caller tells.
 *
 * Matched on `name` as well as on the SDK's class, because the exception a
 * runtime throws here is not something to depend on.
 *
 * @param error - whatever was thrown.
 * @returns the abort, or `undefined` when the failure was something else.
 */
function abortWithin(error: unknown): unknown {
  for (let current: unknown = error, depth = 0; depth < 5; depth += 1) {
    if (current instanceof APIUserAbortError) return current
    if (current instanceof Error && current.name === 'AbortError') return current
    if (!(current instanceof Error) || current.cause === undefined) return undefined
    current = current.cause
  }
  return undefined
}

/**
 * The most specific thing that can be said about a failed connection.
 *
 * Node buries the real reason — `ENOTFOUND`, `ECONNREFUSED`, a TLS complaint —
 * in `cause`, leaving the top-level message as the word-for-word useless
 * `fetch failed`, and the SDK then wraps that in a `cause` of its own. So this
 * walks the chain rather than looking one level down, and prefers a `code`
 * wherever it finds one: `ENOTFOUND` is the word worth recording.
 *
 * @param error - whatever the request rejected with.
 * @returns a `: reason` suffix, or an empty string when there is nothing to add.
 */
function reasonOf(error: unknown): string {
  let best = ''
  let current: unknown = error

  for (let depth = 0; depth < 5; depth += 1) {
    const cause: unknown = current instanceof Error ? current.cause : undefined
    if (cause === undefined || cause === null) break

    const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined
    const message = cause instanceof Error ? cause.message : undefined
    const detail = [code, message]
      .filter((part) => part !== undefined && part.length > 0)
      .join(': ')

    // A `code` is the end of the search: it is the most specific thing anybody
    // is going to get, and the layers below it only restate the same failure.
    if (code !== undefined) return `: ${truncate(detail)}`
    if (best === '' && detail.length > 0) best = detail
    current = cause
  }

  if (best !== '') return `: ${truncate(best)}`
  return error instanceof Error && error.message.length > 0 ? `: ${truncate(error.message)}` : ''
}

/** Keep a provider's prose out of the log at full length. */
function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
