/**
 * The right-hand column, checked against the wire.
 *
 * The acceptance criterion for this step is a strong one — the column is
 * byte-identical to what the provider was actually sent — and it is only worth
 * anything if it is measured across the whole stack rather than asserted in
 * one process. So this test runs a real server over a real socket, watches the
 * feed the way a browser does, folds what arrives with the same
 * `deriveMessages` the browser imports, and compares the bytes with the
 * request the adapter was handed.
 *
 * The last hop — that `modelViewJson` paints exactly `JSON.stringify(messages,
 * null, 2)` — is `apps/web/test/model-view.test.ts`. Together the two say: what
 * is on screen is what went out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveMessages } from '@harness/exchange'
import type { ModelAdapter, ModelMessage, StreamChunk } from '@harness/llm'
import type { SessionEvent } from '@harness/session'
import { createHarnessServer } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'
import { connectSse } from './helpers/sse-client.ts'

/** Frames one exchange produces: the message, two deltas, the assembled reply. */
const FRAMES_PER_EXCHANGE = 4

let harness: HarnessServer
let origin: string
/** Every request the provider received, in order, exactly as it received it. */
let sent: ModelMessage[][]

/** A provider that keeps its post. */
function recordingAdapter(): ModelAdapter {
  return {
    name: 'recording',
    async *stream(messages): AsyncGenerator<StreamChunk> {
      sent.push([...messages])
      yield { type: 'text-delta', text: 'hi ' }
      yield { type: 'text-delta', text: 'there' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

beforeEach(async () => {
  sent = []
  harness = createHarnessServer({ adapter: recordingAdapter(), heartbeatMs: 0 })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await harness.close()
})

async function say(text: string): Promise<void> {
  const response = await fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`POST /messages answered ${response.status}`)
}

/**
 * What a browser holding these events would have painted, per request.
 *
 * A replica is a prefix of the log, so the replica at the instant a request
 * was made is the events up to and including its `user/message` — which is
 * exactly what the column shows for as long as the reply is streaming.
 *
 * @param events - everything the client has received.
 * @returns one JSON request per exchange, in order.
 */
function paintedRequests(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'user/message')
    .map((start) => {
      const replica = events.filter((event) => event.seq <= start.seq)
      return JSON.stringify(deriveMessages(replica), null, 2)
    })
}

/** The same requests, as the provider was handed them. */
function actualRequests(): string[] {
  return sent.map((messages) => JSON.stringify(messages, null, 2))
}

describe('the model view', () => {
  it('is byte-identical to the request the provider was handed', async () => {
    const client = await connectSse(`${origin}/events`)

    await say('hello')
    await client.waitForFrames(FRAMES_PER_EXCHANGE)
    await client.close()

    expect(paintedRequests(client.events())).toEqual(actualRequests())
    expect(actualRequests()[0]).toBe(`[
  {
    "role": "user",
    "content": "hello"
  }
]`)
  })

  it('carries the previous reply into the next request, and the browser sees that too', async () => {
    const client = await connectSse(`${origin}/events`)

    await say('hello')
    await say('again')
    await client.waitForFrames(FRAMES_PER_EXCHANGE * 2)
    await client.close()

    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'again' },
    ])
    expect(paintedRequests(client.events())).toEqual(actualRequests())
  })

  it('is reproduced exactly by a page that loads afterwards', async () => {
    await say('hello')
    await say('again')

    // A refresh: a new connection, the whole log replayed, nothing kept from
    // before. The requests it can reconstruct are the requests that were made.
    const reloaded = await connectSse(`${origin}/events`)
    await reloaded.waitForFrames(FRAMES_PER_EXCHANGE * 2)
    await reloaded.close()

    expect(paintedRequests(reloaded.events())).toEqual(actualRequests())
  })

  it('needs nothing from the server but the log', async () => {
    // No endpoint hands the browser a message list, and none should: a second
    // way to learn what the model sees is a second thing that can be wrong.
    // The events on the feed are sufficient, and this is what says so.
    const client = await connectSse(`${origin}/events`)
    await say('hello')
    await client.waitForFrames(FRAMES_PER_EXCHANGE)
    await client.close()

    const types = new Set(client.events().map((event) => event.type))
    expect([...types]).toEqual(['user/message', 'assistant/chunk', 'assistant/message'])
    expect(paintedRequests(client.events())).toEqual(actualRequests())
  })
})
