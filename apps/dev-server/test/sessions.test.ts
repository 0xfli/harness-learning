/**
 * The acceptance criteria for loading a session on purpose.
 *
 * The question these answer is not "can the harness remember?" — the journal
 * settled that — but "does it remember only when asked?". A run starts a
 * session of its own; every earlier one is reachable by name and by nothing
 * else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore } from '@harness/session/store'
import type { SessionSummary } from '@harness/session'
import { createHarnessServer } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'
import { connectSse } from './helpers/sse-client.ts'

let dir: string
let harness: HarnessServer
let origin: string

/** Start a server over the shared directory, as a second run would. */
async function startHarness(currentId?: string): Promise<HarnessServer> {
  const server = createHarnessServer({
    sessions: openSessionStore({ dir }),
    heartbeatMs: 0,
    ...(currentId === undefined ? {} : { currentId }),
  })
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))
  return server
}

/** The origin a started harness is reachable at. */
function originOf(server: HarnessServer): string {
  const address = server.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'harness-sessions-')), 'sessions')
  harness = await startHarness()
  origin = originOf(harness)
})

afterEach(async () => {
  await harness.close()
  rmSync(dir, { recursive: true, force: true })
})

async function say(where: string, text: string): Promise<Response> {
  return fetch(where, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

async function list(where = origin): Promise<{ current: string; sessions: SessionSummary[] }> {
  const response = await fetch(`${where}/sessions`)
  return (await response.json()) as { current: string; sessions: SessionSummary[] }
}

describe('GET /sessions', () => {
  it('names the session a request without one would reach', async () => {
    const { current, sessions } = await list()

    expect(current).toBe(harness.current.id)
    expect(sessions.map((session) => session.id)).toEqual([current])
  })

  it('summarises every session on the shelf, most recently active first', async () => {
    await say(`${origin}/messages`, 'the first conversation')
    const first = harness.current.id
    const second = (
      (await (await fetch(`${origin}/sessions`, { method: 'POST' })).json()) as {
        current: string
      }
    ).current
    await say(`${origin}/messages`, 'the second conversation')

    const { sessions } = await list()

    expect(sessions.map((session) => session.id)).toEqual([second, first])
    expect(sessions.map((session) => session.title)).toEqual([
      'the second conversation',
      'the first conversation',
    ])
    expect(sessions[1]?.events).toBeGreaterThan(0)
  })
})

describe('POST /sessions', () => {
  it('starts a session and makes it the one bare requests reach', async () => {
    const before = harness.current.id
    await say(`${origin}/messages`, 'said in the first')

    const response = await fetch(`${origin}/sessions`, { method: 'POST' })
    const body = (await response.json()) as { current: string; session: SessionSummary }

    expect(response.status).toBe(201)
    expect(body.current).not.toBe(before)
    expect(body.session).toEqual({
      id: body.current,
      events: 0,
      startedAt: undefined,
      updatedAt: undefined,
      title: undefined,
    })
    // The new one is empty, and the old one is untouched by having been left.
    expect((await (await fetch(`${origin}/events.json`)).json()) as unknown[]).toEqual([])
    expect(
      ((await (await fetch(`${origin}/events.json?session=${before}`)).json()) as unknown[]).length,
    ).toBeGreaterThan(0)
  })
})

describe('GET /sessions/<id>', () => {
  it('summarises one session', async () => {
    await say(`${origin}/messages`, 'a question')

    const response = await fetch(`${origin}/sessions/${harness.current.id}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: harness.current.id, title: 'a question' })
  })

  it('refuses an id it has never recorded', async () => {
    const response = await fetch(`${origin}/sessions/20260823-074139-k3f9`)

    expect(response.status).toBe(404)
  })

  it('refuses an id that could not name a session', async () => {
    // Not a 404 with a helpful hint: a path that walks out of the store is a
    // question the harness declines to answer at all.
    const response = await fetch(`${origin}/sessions/${encodeURIComponent('../../etc/passwd')}`)

    expect(response.status).toBe(404)
  })
})

describe('?session=<id>', () => {
  it('reads and writes the session it names', async () => {
    await say(`${origin}/messages`, 'said in the first')
    const first = harness.current.id
    await fetch(`${origin}/sessions`, { method: 'POST' })

    await say(`${origin}/messages?session=${first}`, 'said in the first again')

    const events = (await (await fetch(`${origin}/events.json?session=${first}`)).json()) as {
      type: string
      data: { text?: string }
    }[]
    expect(
      events.filter((event) => event.type === 'user/message').map((event) => event.data.text),
    ).toEqual(['said in the first', 'said in the first again'])
    // And the session started in between saw none of it.
    expect((await (await fetch(`${origin}/events.json`)).json()) as unknown[]).toEqual([])
  })

  it('streams the session it names', async () => {
    await say(`${origin}/messages`, 'said in the first')
    const first = harness.current.id
    await fetch(`${origin}/sessions`, { method: 'POST' })

    const client = await connectSse(`${origin}/events?session=${first}`)
    await client.waitForFrames(1)
    await client.close()

    // A feed is one cursor over one log: the frames are that session's, from
    // its own seq 0, whatever else the server has open.
    expect(client.events()[0]?.seq).toBe(0)
    expect(client.events()[0]?.type).toBe('user/message')
  })

  it('refuses an unknown session rather than starting one behind the caller', async () => {
    const missing = await fetch(`${origin}/events.json?session=20260823-074139-k3f9`)
    const posted = await say(`${origin}/messages?session=20260823-074139-k3f9`, 'hello?')

    expect(missing.status).toBe(404)
    expect(posted.status).toBe(404)
    expect((await list()).sessions).toHaveLength(1)
  })

  it('refuses an id that is not one', async () => {
    const response = await fetch(`${origin}/events.json?session=${encodeURIComponent('../evil')}`)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: '"../evil" is not a session id' })
  })
})

describe('a second run over the same shelf', () => {
  it('starts a session of its own and touches none of the stored ones', async () => {
    await say(`${origin}/messages`, 'said before the restart')
    const before = harness.current.id
    await harness.close()

    harness = await startHarness()
    origin = originOf(harness)
    const { current, sessions } = await list()

    // The whole point: the conversation survived, and the new run did not
    // silently continue it.
    expect(current).not.toBe(before)
    expect(sessions.map((session) => session.id)).toEqual([current, before])
    expect((await (await fetch(`${origin}/events.json`)).json()) as unknown[]).toEqual([])
  })

  it('loads a stored session on demand, byte for byte', async () => {
    await say(`${origin}/messages`, 'said before the restart')
    const before = harness.current.id
    const events = (await (await fetch(`${origin}/events.json`)).json()) as unknown[]
    await harness.close()

    harness = await startHarness()
    origin = originOf(harness)

    expect(await (await fetch(`${origin}/events.json?session=${before}`)).json()).toEqual(events)
  })

  it('resumes a named session when the environment asked for one', async () => {
    await say(`${origin}/messages`, 'said before the restart')
    const before = harness.current.id
    await harness.close()

    harness = await startHarness(before)
    origin = originOf(harness)

    expect((await list()).current).toBe(before)
    expect(
      ((await (await fetch(`${origin}/events.json`)).json()) as unknown[]).length,
    ).toBeGreaterThan(0)
  })

  it('leaves nothing on the shelf when nobody said anything', async () => {
    await harness.close()

    harness = await startHarness()
    origin = originOf(harness)

    // Three runs, no conversations, no files: an empty session never happened.
    expect((await list()).sessions.map((session) => session.events)).toEqual([0])
  })
})
