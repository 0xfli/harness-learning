import { describe, expect, it } from 'vitest'
import { createScriptedAdapter, splitIntoDeltas } from '../src/scripted.ts'
import type { ModelMessage, StreamChunk } from '../src/types.ts'

const HELLO: readonly ModelMessage[] = [{ role: 'user', content: 'hello' }]

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function textOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

describe('splitIntoDeltas', () => {
  it.each([
    ['hello world'],
    ['  leading and trailing  '],
    ['one'],
    ['punctuation, and — dashes.'],
    ['multi\nline\ntext'],
    ['世界 你好'],
  ])('is lossless for %j', (text) => {
    expect(splitIntoDeltas(text).join('')).toBe(text)
  })

  it('splits on words rather than returning one lump', () => {
    expect(splitIntoDeltas('one two three')).toEqual(['one', ' two', ' three'])
  })

  it('has no deltas for empty text', () => {
    expect(splitIntoDeltas('')).toEqual([])
  })
})

describe('createScriptedAdapter', () => {
  it('streams the scripted reply as text deltas, then finish, then usage', async () => {
    const adapter = createScriptedAdapter({ reply: 'a b c' })

    const chunks = await collect(adapter.stream(HELLO))

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'text-delta',
      'text-delta',
      'text-delta',
      'finish',
      'usage',
    ])
  })

  it('emits deltas that concatenate to the reply', async () => {
    const reply = 'the concatenation of the deltas is the message'
    const adapter = createScriptedAdapter({ reply })

    expect(textOf(await collect(adapter.stream(HELLO)))).toBe(reply)
  })

  it('is deterministic across runs', async () => {
    const adapter = createScriptedAdapter()

    const first = await collect(adapter.stream(HELLO))
    const second = await collect(adapter.stream(HELLO))

    expect(first).toEqual(second)
  })

  it('reports usage the caller can read', async () => {
    const adapter = createScriptedAdapter({ reply: 'one two three' })

    const usage = (await collect(adapter.stream(HELLO))).find((chunk) => chunk.type === 'usage')

    expect(usage).toEqual({ type: 'usage', input: 1, output: 3 })
  })

  it('can mimic a provider that reports no usage', async () => {
    const adapter = createScriptedAdapter({ reply: 'quiet', reportUsage: false })

    const chunks = await collect(adapter.stream(HELLO))

    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false)
  })

  it('reports the configured finish reason', async () => {
    const adapter = createScriptedAdapter({ reply: 'cut', finishReason: 'length' })

    const chunks = await collect(adapter.stream(HELLO))

    expect(chunks).toContainEqual({ type: 'finish', reason: 'length' })
  })

  it('answers with the last user message so the demo is not obviously canned', async () => {
    const adapter = createScriptedAdapter()

    const text = textOf(
      await collect(
        adapter.stream([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ]),
      ),
    )

    expect(text).toContain('"second"')
  })

  it('stops when the request is aborted mid-stream', async () => {
    const adapter = createScriptedAdapter({ reply: 'one two three four', delayMs: 5 })
    const controller = new AbortController()

    const received: string[] = []
    const run = async (): Promise<void> => {
      for await (const chunk of adapter.stream(HELLO, { signal: controller.signal })) {
        if (chunk.type === 'text-delta') received.push(chunk.text)
        if (received.length === 2) controller.abort()
      }
    }

    await expect(run()).rejects.toThrow(/abort/i)
    expect(received).toEqual(['one', ' two'])
  })

  it('refuses to start when the signal is already aborted', async () => {
    const adapter = createScriptedAdapter({ reply: 'never sent' })

    await expect(collect(adapter.stream(HELLO, { signal: AbortSignal.abort() }))).rejects.toThrow(
      /abort/i,
    )
  })
})
