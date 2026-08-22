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

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
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

    const headers = withKey.calls[0]?.init?.headers as Record<string, string>
    const noHeaders = withoutKey.calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers.authorization).toBe(['Bearer', 'secret'].join(' '))
    expect(noHeaders?.authorization).toBeUndefined()
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
})
