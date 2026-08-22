/**
 * `POST /messages` end to end: a real socket, a real SSE feed, and the four
 * acceptance criteria for step #3 asserted against what a browser would
 * actually receive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter, StreamChunk } from '@harness/llm'
import { createHarnessServer } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'
import { connectSse } from './helpers/sse-client.ts'

const REPLY = 'one two three four'

let harness: HarnessServer
let origin: string

async function listen(adapter: ModelAdapter): Promise<void> {
  harness = createHarnessServer({ adapter, heartbeatMs: 0 })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
}

beforeEach(async () => {
  await listen(createScriptedAdapter({ reply: REPLY }))
})

afterEach(async () => {
  await harness.close()
})

async function say(body: unknown): Promise<Response> {
  return fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function typesOf(harnessServer: HarnessServer): string[] {
  return harnessServer.log.events.map((event) => event.type)
}

describe('POST /messages', () => {
  it('records a user message, a run of chunks, then exactly one assistant message', async () => {
    const response = await say({ text: 'hello' })

    expect(response.status).toBe(200)
    expect(typesOf(harness)).toEqual([
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/usage',
      'assistant/message',
    ])
  })

  it('answers with the assembled reply and what it cost', async () => {
    const body = (await (await say({ text: 'hello' })).json()) as Record<string, unknown>

    expect(body).toMatchObject({
      text: REPLY,
      reason: 'stop',
      chunks: 4,
      usage: { input: 1, output: 4 },
    })
  })

  it('streams every delta to a connected client as its own event', async () => {
    const client = await connectSse(`${origin}/events`)

    await say({ text: 'hello' })
    await client.waitForFrames(7)
    await client.close()

    const events = client.events()
    const deltas = events.filter((event) => event.type === 'assistant/chunk')
    expect(deltas).toHaveLength(4)
    expect(deltas.map((event) => event.data.text).join('')).toBe(REPLY)
  })

  it('still shows every chunk to a client that connects afterwards', async () => {
    // The reload criterion: a browser opened after the reply finished sees the
    // same history, deltas and all, because the deltas are events rather than
    // a rendering that happened once.
    await say({ text: 'hello' })

    const reloaded = await connectSse(`${origin}/events`)
    await reloaded.waitForFrames(7)
    await reloaded.close()

    const events = reloaded.events()
    expect(events.map((event) => event.type)).toEqual(typesOf(harness))
    expect(
      events
        .filter((event) => event.type === 'assistant/chunk')
        .map((event) => event.data.text)
        .join(''),
    ).toBe(REPLY)
  })

  it('ties every event of one reply together with a shared id', async () => {
    const body = (await (await say({ text: 'hello' })).json()) as { id: string }

    expect(harness.log.events.map((event) => event.data.id)).toEqual(Array<string>(7).fill(body.id))
  })

  it('keeps two replies apart when they interleave', async () => {
    await harness.close()
    await listen(createScriptedAdapter({ reply: 'a b c', delayMs: 5 }))

    const [first, second] = await Promise.all([
      (await say({ text: 'one' })).json() as Promise<{ id: string }>,
      (await say({ text: 'two' })).json() as Promise<{ id: string }>,
    ])

    const chunksFor = (id: string) =>
      harness.log.events
        .filter((event) => event.type === 'assistant/chunk' && event.data.id === id)
        .map((event) => event.data.text)
        .join('')
    expect(first.id).not.toBe(second.id)
    expect(chunksFor(first.id)).toBe('a b c')
    expect(chunksFor(second.id)).toBe('a b c')
  })

  it('captures usage as an event a client can read off the feed', async () => {
    await say({ text: 'hello' })

    const usage = harness.log.events.find((event) => event.type === 'assistant/usage')
    expect(usage?.data).toMatchObject({ input: 1, output: 4 })
  })

  it.each([
    ['no text', {}],
    ['a blank message', { text: '   ' }],
    ['the wrong type', { text: 42 }],
  ])('rejects %s without touching the log', async (_label, body) => {
    const response = await say(body)

    expect(response.status).toBe(400)
    expect(harness.log.length).toBe(0)
  })

  it('rejects a body that is not an object', async () => {
    const response = await fetch(`${origin}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"',
    })

    expect(response.status).toBe(400)
  })

  describe('when the provider fails', () => {
    const failing: ModelAdapter = {
      name: 'failing',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', text: 'partial' }
        await Promise.resolve()
        throw new Error('provider hung up')
      },
    }

    it('answers 502 and leaves the failure in the log', async () => {
      await harness.close()
      await listen(failing)

      const response = await say({ text: 'hello' })

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'provider hung up' })
      expect(typesOf(harness)).toEqual(['user/message', 'assistant/chunk', 'error/stream'])
    })

    it('keeps the delta that did arrive', async () => {
      await harness.close()
      await listen(failing)

      await say({ text: 'hello' })

      const chunk = harness.log.events.find((event) => event.type === 'assistant/chunk')
      expect(chunk?.data.text).toBe('partial')
    })
  })
})
