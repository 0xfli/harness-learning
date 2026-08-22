import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { createHarnessServer, seedDemoEvents } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'
import { connectSse } from './helpers/sse-client.ts'

let harness: HarnessServer
let origin: string

beforeEach(async () => {
  // Heartbeats are off so every frame a test sees is a real event.
  harness = createHarnessServer({ heartbeatMs: 0 })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await harness.close()
})

async function post(type: string, data: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, data }),
  })
}

describe('GET /events', () => {
  it('sends the full history, then live events, in seq order', async () => {
    seedDemoEvents(harness.log)

    const client = await connectSse(`${origin}/events`)
    await client.waitForFrames(3)
    harness.log.append('demo/hello', { message: 'live' })
    await client.waitForFrames(4)
    await client.close()

    const events = client.events()
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    expect(events.map((event) => event.type)).toEqual(Array<string>(4).fill('demo/hello'))
    expect(events[3]?.data).toEqual({ message: 'live' })
  })

  it('sends no gaps and no duplicates when history is long', async () => {
    for (let n = 0; n < 50; n += 1) harness.log.append('demo/hello', { n })

    const client = await connectSse(`${origin}/events`)
    await client.waitForFrames(50)
    for (let n = 50; n < 60; n += 1) harness.log.append('demo/hello', { n })
    await client.waitForFrames(60)
    await client.close()

    const seqs = client.events().map((event) => event.seq)
    expect(seqs).toEqual(Array.from({ length: 60 }, (_unused, index) => index))
    expect(new Set(seqs).size).toBe(60)
  })

  it('uses seq as the SSE id so clients can resume', async () => {
    harness.log.append('demo/hello', { n: 0 })

    const client = await connectSse(`${origin}/events`)
    await client.waitForFrames(1)
    await client.close()

    expect(client.frames[0]?.id).toBe('0')
  })

  it('delivers a newly appended event to two simultaneous clients', async () => {
    seedDemoEvents(harness.log)

    const first = await connectSse(`${origin}/events`)
    const second = await connectSse(`${origin}/events`)
    await first.waitForFrames(3)
    await second.waitForFrames(3)

    const response = await post('demo/hello', { message: 'broadcast' })
    expect(response.status).toBe(201)

    await first.waitForFrames(4)
    await second.waitForFrames(4)
    await Promise.all([first.close(), second.close()])

    const fromFirst = first.events()[3]
    const fromSecond = second.events()[3]
    expect(fromFirst).toEqual(fromSecond)
    expect(fromFirst?.data).toEqual({ message: 'broadcast' })
    expect(fromFirst?.seq).toBe(3)
  })

  it('resumes from Last-Event-ID without replaying what the client already has', async () => {
    for (let n = 0; n < 5; n += 1) harness.log.append('demo/hello', { n })

    const client = await connectSse(`${origin}/events`, { 'last-event-id': '2' })
    await client.waitForFrames(2)
    harness.log.append('demo/hello', { n: 5 })
    await client.waitForFrames(3)
    await client.close()

    expect(client.events().map((event) => event.seq)).toEqual([3, 4, 5])
  })

  it('ignores a nonsense Last-Event-ID and replays everything', async () => {
    harness.log.append('demo/hello', { n: 0 })

    const client = await connectSse(`${origin}/events`, { 'last-event-id': 'not-a-number' })
    await client.waitForFrames(1)
    await client.close()

    expect(client.events().map((event) => event.seq)).toEqual([0])
  })

  it('detaches its observer when the client disconnects', async () => {
    const client = await connectSse(`${origin}/events`)
    harness.log.append('demo/hello')
    await client.waitForFrames(1)
    expect(harness.log.observerCount).toBe(1)

    await client.close()

    const deadline = Date.now() + 2_000
    while (harness.log.observerCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(harness.log.observerCount).toBe(0)
  })

  it('announces itself as an event stream', async () => {
    const controller = new AbortController()
    const response = await fetch(`${origin}/events`, { signal: controller.signal })

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-cache')
    controller.abort()
  })
})

describe('POST /events', () => {
  it('appends and returns the committed event', async () => {
    const response = await post('demo/hello', { message: 'from curl' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      seq: 0,
      type: 'demo/hello',
      time: expect.any(Number),
      data: { message: 'from curl' },
    })
    expect(harness.log.length).toBe(1)
  })

  it('rejects a missing type', async () => {
    const response = await fetch(`${origin}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    })

    expect(response.status).toBe(400)
    expect(harness.log.length).toBe(0)
  })

  it('rejects a body that is not a JSON object', async () => {
    const response = await fetch(`${origin}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
  })

  it('defaults missing data to an empty record', async () => {
    const response = await fetch(`${origin}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'demo/hello' }),
    })

    expect(response.status).toBe(201)
    expect(harness.log.at(0)?.data).toEqual({})
  })
})

describe('other routes', () => {
  it('serves the history as JSON', async () => {
    seedDemoEvents(harness.log)

    const response = await fetch(`${origin}/events.json`)

    expect(response.status).toBe(200)
    expect((await response.json()) as unknown[]).toHaveLength(3)
  })

  it('reports health', async () => {
    const response = await fetch(`${origin}/health`)

    expect(await response.json()).toEqual({ ok: true, events: 0 })
  })

  it('serves usage at the root', async () => {
    const response = await fetch(`${origin}/`)

    expect(await response.text()).toContain('/events')
  })

  it('404s an unknown route', async () => {
    const response = await fetch(`${origin}/nope`)

    expect(response.status).toBe(404)
  })
})

describe('seedDemoEvents', () => {
  it('writes a few demo/hello events', () => {
    const log = new SessionLog()

    seedDemoEvents(log)

    expect(log.events.map((event) => event.type)).toEqual([
      'demo/hello',
      'demo/hello',
      'demo/hello',
    ])
  })
})
