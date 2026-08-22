import { describe, expect, it } from 'vitest'
import { createOpenAiAdapter } from '../src/openai.ts'
import { ModelStreamError } from '../src/types.ts'
import type { ModelMessage, StreamChunk } from '../src/types.ts'

const HELLO: readonly ModelMessage[] = [{ role: 'user', content: 'hello' }]

/** A `fetch` that replays a canned SSE body, and records what it was sent. */
function stubFetch(frames: readonly string[], init: { status?: number; body?: string } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = []

  const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit })
    const status = init.status ?? 200
    if (status >= 400) {
      return new Response(init.body ?? 'nope', { status, statusText: 'Bad Request' })
    }
    return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
      status,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch

  return { fetch: fetchImpl, calls }
}

/** One `chat.completion.chunk` frame carrying a content delta. */
function delta(content: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { content } }] })
}

/** One frame carrying a reasoning delta, as a thinking model streams it. */
function reasoning(text: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: text } }] })
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/**
 * One header off a recorded call.
 *
 * The SDK normalises headers into a `Headers` before handing them to `fetch`,
 * so reading them as a plain object silently finds nothing.
 */
function headerOf(call: { init: RequestInit | undefined } | undefined, header: string) {
  return new Headers(call?.init?.headers).get(header)
}

/** The request body of a recorded call, parsed. */
function bodyOf(call: { init: RequestInit | undefined } | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>
}

describe('createOpenAiAdapter', () => {
  it('turns content deltas into text-delta chunks', async () => {
    const { fetch } = stubFetch([delta('Hel'), delta('lo'), '[DONE]'])
    const adapter = createOpenAiAdapter({ model: 'test-model', apiKey: 'k', fetch })

    const chunks = await collect(adapter.stream(HELLO))

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
    ])
  })

  it('reads the finish reason and the usage report', async () => {
    const { fetch } = stubFetch([
      delta('hi'),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
      '[DONE]',
    ])
    const adapter = createOpenAiAdapter({ model: 'test-model', fetch })

    const chunks = await collect(adapter.stream(HELLO))

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'hi' },
      { type: 'finish', reason: 'stop' },
      { type: 'usage', input: 11, output: 3 },
    ])
  })

  it('asks for usage, which providers otherwise omit from a stream', async () => {
    const { fetch, calls } = stubFetch(['[DONE]'])
    const adapter = createOpenAiAdapter({ model: 'test-model', apiKey: 'secret', fetch })

    await collect(adapter.stream(HELLO))

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('sends the key as a bearer token, and no header without one', async () => {
    const withKey = stubFetch(['[DONE]'])
    await collect(
      createOpenAiAdapter({ model: 'm', apiKey: 'secret', fetch: withKey.fetch }).stream(HELLO),
    )
    const withoutKey = stubFetch(['[DONE]'])
    await collect(createOpenAiAdapter({ model: 'm', fetch: withoutKey.fetch }).stream(HELLO))

    expect(headerOf(withKey.calls[0], 'authorization')).toBe(['Bearer', 'secret'].join(' '))
    // Absent, not empty: a provider that wants no credentials should see no
    // header rather than `Bearer` followed by nothing.
    expect(headerOf(withoutKey.calls[0], 'authorization')).toBeNull()
  })

  it('trims a trailing slash off the base url rather than doubling it', async () => {
    const { fetch, calls } = stubFetch(['[DONE]'])
    const adapter = createOpenAiAdapter({ model: 'm', baseUrl: 'http://localhost:1234/v1/', fetch })

    await collect(adapter.stream(HELLO))

    expect(calls[0]?.url).toBe('http://localhost:1234/v1/chat/completions')
  })

  it('stops at [DONE] without parsing it as JSON', async () => {
    const { fetch } = stubFetch(['[DONE]', delta('after the end')])
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    expect(await collect(adapter.stream(HELLO))).toEqual([])
  })

  it('ignores empty deltas and frames it does not recognise', async () => {
    const { fetch } = stubFetch([
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
      JSON.stringify({ something: 'new' }),
      '[]',
      delta('real'),
    ])
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    expect(await collect(adapter.stream(HELLO))).toEqual([{ type: 'text-delta', text: 'real' }])
  })

  it('reports a rejected request with its status', async () => {
    const { fetch } = stubFetch([], { status: 429, body: 'slow down' })
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    const failure = await collect(adapter.stream(HELLO)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ModelStreamError)
    expect(failure).toMatchObject({ status: 429 })
    expect((failure as Error).message).toContain('slow down')
  })

  it('reports an error delivered inside a 200 stream', async () => {
    const { fetch } = stubFetch([
      delta('partial'),
      JSON.stringify({ error: { message: 'context length exceeded' } }),
    ])
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    await expect(collect(adapter.stream(HELLO))).rejects.toThrow('context length exceeded')
  })

  it('reports a frame that is not JSON', async () => {
    const { fetch } = stubFetch(['{not json'])
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    await expect(collect(adapter.stream(HELLO))).rejects.toThrow(ModelStreamError)
  })

  it('names itself after the model unless told otherwise', () => {
    const { fetch } = stubFetch([])
    expect(createOpenAiAdapter({ model: 'deepseek-chat', fetch }).name).toBe('openai:deepseek-chat')
    expect(createOpenAiAdapter({ model: 'x', name: 'local', fetch }).name).toBe('local')
  })

  it('says why the request never left, rather than only "fetch failed"', async () => {
    // What Node actually throws when a name will not resolve: a useless
    // message with the whole story one layer down in `cause`.
    const failed = new TypeError('fetch failed')
    failed.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
    })
    const fetch = (() => Promise.reject(failed)) as unknown as typeof globalThis.fetch
    const adapter = createOpenAiAdapter({
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      fetch,
    })

    const failure = await collect(adapter.stream(HELLO)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ModelStreamError)
    const { message } = failure as Error
    expect(message).toContain('could not be reached')
    // The endpoint, so a typo in the base url is visible on sight.
    expect(message).toContain('https://api.example.com/v1/chat/completions')
    expect(message).toContain('ENOTFOUND')
    expect((failure as Error).cause).toBe(failed)
  })

  it('still says something when the failure carries no cause at all', async () => {
    const fetch = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    await expect(collect(adapter.stream(HELLO))).rejects.toThrow(
      /could not be reached.*fetch failed/,
    )
  })

  it('lets an abort stay an abort, because the caller asked for it', async () => {
    // Wrapping this would make "the user navigated away" indistinguishable
    // from "the provider is unreachable" in the log.
    const aborted = new Error('This operation was aborted')
    aborted.name = 'AbortError'
    const fetch = (() => Promise.reject(aborted)) as unknown as typeof globalThis.fetch
    const adapter = createOpenAiAdapter({ model: 'm', fetch })

    const failure = await collect(adapter.stream(HELLO)).catch((error: unknown) => error)

    expect(failure).toBe(aborted)
    expect(failure).not.toBeInstanceOf(ModelStreamError)
  })

  describe('reasoning', () => {
    it('turns reasoning_content into chunks of its own, not text deltas', async () => {
      const { fetch } = stubFetch([reasoning('17*23'), reasoning(' = 391'), delta('391'), '[DONE]'])
      const adapter = createOpenAiAdapter({ model: 'm', apiKey: 'k', fetch })

      const chunks = await collect(adapter.stream(HELLO))

      expect(chunks).toEqual([
        { type: 'reasoning-delta', text: '17*23' },
        { type: 'reasoning-delta', text: ' = 391' },
        { type: 'text-delta', text: '391' },
      ])
    })

    it('keeps the reply text free of reasoning, which is the whole point', async () => {
      // The invariant every other layer leans on: concatenating the text
      // deltas is the message. Reasoning arriving down the same socket must
      // not end up inside it.
      const { fetch } = stubFetch([reasoning('thinking hard'), delta('hi'), '[DONE]'])
      const adapter = createOpenAiAdapter({ model: 'm', apiKey: 'k', fetch })

      const chunks = await collect(adapter.stream(HELLO))
      const text = chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join('')

      expect(text).toBe('hi')
    })

    it('reads both when one frame carries reasoning and content together', async () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: 'so', content: 'yes' } }],
      })
      const { fetch } = stubFetch([frame, '[DONE]'])
      const adapter = createOpenAiAdapter({ model: 'm', apiKey: 'k', fetch })

      expect(await collect(adapter.stream(HELLO))).toEqual([
        { type: 'reasoning-delta', text: 'so' },
        { type: 'text-delta', text: 'yes' },
      ])
    })

    it('asks for an effort only when one was configured', async () => {
      const plain = stubFetch(['[DONE]'])
      await collect(
        createOpenAiAdapter({ model: 'm', apiKey: 'k', fetch: plain.fetch }).stream(HELLO),
      )
      const hard = stubFetch(['[DONE]'])
      await collect(
        createOpenAiAdapter({
          model: 'm',
          apiKey: 'k',
          reasoning: 'high',
          thinking: 'enabled',
          fetch: hard.fetch,
        }).stream(HELLO),
      )

      // Absent by default: a model that does not reason rejects the field
      // rather than ignoring it.
      expect(bodyOf(plain.calls[0])).not.toHaveProperty('reasoning_effort')
      expect(bodyOf(plain.calls[0])).not.toHaveProperty('thinking')
      expect(bodyOf(hard.calls[0])).toMatchObject({
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
      })
    })

    it('can ask a model that reasons by default to stop', async () => {
      const { fetch, calls } = stubFetch(['[DONE]'])
      const adapter = createOpenAiAdapter({
        model: 'm',
        apiKey: 'k',
        thinking: 'disabled',
        fetch,
      })

      await collect(adapter.stream(HELLO))

      expect(bodyOf(calls[0])).toMatchObject({ thinking: { type: 'disabled' } })
    })
  })
})
