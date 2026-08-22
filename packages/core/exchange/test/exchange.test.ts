import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter, StreamChunk } from '@harness/llm'
import { recordExchange, replayChunks } from '../src/exchange.ts'

/** Ids that read well in a failure message, instead of UUIDs. */
function counter(prefix = 'm'): () => string {
  let next = 0
  return () => `${prefix}${(next += 1)}`
}

/** An adapter that yields exactly the chunks it was given. */
function fixedAdapter(chunks: readonly StreamChunk[], name = 'fixed'): ModelAdapter {
  return {
    name,
    async *stream(): AsyncGenerator<StreamChunk> {
      yield* chunks
    },
  }
}

function typesOf(log: SessionLog): string[] {
  return log.events.map((event) => event.type)
}

describe('recordExchange', () => {
  it('records a user message, a run of chunks, then exactly one assistant message', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'one two three' })

    await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(typesOf(log)).toEqual([
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/usage',
      'assistant/message',
    ])
    expect(log.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('concatenates the chunk deltas into exactly the assembled message text', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: '  ragged   spacing, and 世界.  ' })

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(replayChunks(log.events, result.id)).toBe(result.text)
    expect(result.assistantMessage.data.text).toBe(result.text)
    expect(result.text).toBe('  ragged   spacing, and 世界.  ')
  })

  it('reassembles from the log alone, long after the stream closed', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'survives a reload' })

    const { id } = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    // What a reconnecting client receives: the events, and nothing else.
    const replayed = JSON.parse(JSON.stringify(log.events)) as { type: string; data: unknown }[]
    expect(replayed.filter((event) => event.type === 'assistant/chunk')).toHaveLength(3)
    expect(replayChunks(replayed as never, id)).toBe('survives a reload')
  })

  it('captures provider-reported usage as its own event', async () => {
    const log = new SessionLog()
    const adapter = fixedAdapter([
      { type: 'text-delta', text: 'hi' },
      { type: 'finish', reason: 'stop' },
      { type: 'usage', input: 42, output: 7 },
    ])

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    const usage = log.events.find((event) => event.type === 'assistant/usage')
    expect(usage?.data).toEqual({ id: 'm1', input: 42, output: 7 })
    expect(result.usage).toEqual({ input: 42, output: 7 })
  })

  it('reports no usage when the provider reports none', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'quiet', reportUsage: false })

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(result.usage).toBeUndefined()
    expect(typesOf(log)).not.toContain('assistant/usage')
  })

  it('tags every event of the exchange with one id', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'a b' })

    await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(log.events.map((event) => event.data.id)).toEqual(['m1', 'm1', 'm1', 'm1', 'm1'])
  })

  it('gives each exchange its own id, so chunks never merge across replies', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'x' })
    const newId = counter()

    const first = await recordExchange({ log, adapter, text: 'one', newId })
    const second = await recordExchange({ log, adapter, text: 'two', newId })

    expect(first.id).not.toBe(second.id)
    expect(replayChunks(log.events, first.id)).toBe('x')
    expect(replayChunks(log.events, second.id)).toBe('x')
  })

  it('numbers chunks in arrival order, independently of seq', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'a b c' })

    await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    const indexes = log.events
      .filter((event) => event.type === 'assistant/chunk')
      .map((event) => event.data.index)
    expect(indexes).toEqual([0, 1, 2])
  })

  it('puts the finish reason on the message rather than in an event of its own', async () => {
    const log = new SessionLog()
    const adapter = fixedAdapter([
      { type: 'text-delta', text: 'cut off' },
      { type: 'finish', reason: 'length' },
    ])

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(result.reason).toBe('length')
    expect(result.assistantMessage.data).toEqual({
      id: 'm1',
      text: 'cut off',
      reason: 'length',
      chunks: 1,
    })
  })

  it('says so when the provider never sent a finish reason', async () => {
    const log = new SessionLog()
    const adapter = fixedAdapter([{ type: 'text-delta', text: 'abrupt' }])

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(result.reason).toBe('unknown')
  })

  it('records an empty reply as a message with no chunks', async () => {
    const log = new SessionLog()
    const adapter = fixedAdapter([{ type: 'finish', reason: 'stop' }])

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(result.text).toBe('')
    expect(result.chunks).toBe(0)
    expect(typesOf(log)).toEqual(['user/message', 'assistant/message'])
  })

  it('rejects an empty message before touching the log', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter()

    await expect(recordExchange({ log, adapter, text: '   ' })).rejects.toThrow(TypeError)
    expect(log.length).toBe(0)
  })

  describe('when the stream fails midway', () => {
    function failingAdapter(after: number, message: string): ModelAdapter {
      return {
        name: 'failing',
        async *stream(): AsyncGenerator<StreamChunk> {
          for (let index = 0; index < after; index += 1) {
            yield { type: 'text-delta', text: `d${index}` }
          }
          throw new Error(message)
        },
      }
    }

    it('keeps the deltas it already recorded and records the failure', async () => {
      const log = new SessionLog()

      await expect(
        recordExchange({
          log,
          adapter: failingAdapter(2, 'connection reset'),
          text: 'hi',
          newId: counter(),
        }),
      ).rejects.toThrow('connection reset')

      expect(typesOf(log)).toEqual([
        'user/message',
        'assistant/chunk',
        'assistant/chunk',
        'error/stream',
      ])
      expect(log.events.at(-1)?.data).toEqual({
        id: 'm1',
        message: 'connection reset',
        chunks: 2,
      })
    })

    it('appends no assistant/message, so completeness stays unambiguous', async () => {
      const log = new SessionLog()

      await expect(
        recordExchange({ log, adapter: failingAdapter(1, 'boom'), text: 'hi' }),
      ).rejects.toThrow('boom')

      expect(typesOf(log)).not.toContain('assistant/message')
    })
  })

  it('stops recording when the caller aborts', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'one two three four five', delayMs: 5 })
    const controller = new AbortController()
    log.observe((event) => {
      if (event.type === 'assistant/chunk' && event.data.index === 1) controller.abort()
    })

    await expect(
      recordExchange({ log, adapter, text: 'hi', signal: controller.signal, newId: counter() }),
    ).rejects.toThrow(/abort/i)

    expect(log.events.filter((event) => event.type === 'assistant/chunk')).toHaveLength(2)
    expect(typesOf(log).at(-1)).toBe('error/stream')
  })
})
