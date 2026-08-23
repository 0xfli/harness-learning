/**
 * Talking to the shelf.
 *
 * Two requests and a navigation, so the interesting part is not the happy
 * path — it is what the client does with an answer that is not quite the shape
 * it hoped for. JSON has no `undefined`, so a session nobody has spoken in
 * arrives without a title, without a clock, and the header has to render it
 * anyway.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionsClient } from '../src/sessions-client.ts'

/** A `fetch` that answers once, and remembers what it was asked. */
function answering(status: number, body: unknown): { calls: Request[] } {
  const calls: Request[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(new Request(new URL(url, 'http://localhost'), init))
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading the shelf', () => {
  it('asks the harness what it has', async () => {
    const { calls } = answering(200, { current: 'b', sessions: [] })

    const catalogue = await createSessionsClient().list()

    expect(calls[0]?.url).toBe('http://localhost/sessions')
    expect(calls[0]?.method).toBe('GET')
    expect(catalogue).toEqual({ current: 'b', sessions: [] })
  })

  it('keeps the order it was given', async () => {
    // Most recently active first is the store's decision, and re-sorting here
    // would be a second opinion about which session somebody wants.
    answering(200, {
      current: 'b',
      sessions: [
        { id: 'b', events: 0 },
        { id: 'a', events: 4, startedAt: 10, updatedAt: 20, title: 'what is a harness?' },
      ],
    })

    const catalogue = await createSessionsClient().list()

    expect(catalogue.sessions.map((summary) => summary.id)).toEqual(['b', 'a'])
    expect(catalogue.sessions[1]?.title).toBe('what is a harness?')
  })

  it('fills in what the wire could not say', async () => {
    // The fields are absent rather than null: a summary with nothing to say
    // says nothing. The page needs them present and `undefined`.
    answering(200, { current: 'b', sessions: [{ id: 'b', events: 0 }] })

    const [summary] = (await createSessionsClient().list()).sessions

    expect(summary).toEqual({
      id: 'b',
      events: 0,
      startedAt: undefined,
      updatedAt: undefined,
      title: undefined,
    })
  })

  it('carries the complaint the harness sent', async () => {
    answering(500, { error: 'the shelf is on fire' })

    await expect(createSessionsClient().list()).rejects.toThrow('the shelf is on fire')
  })

  it('reports the status when there is no complaint to carry', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>nope</html>', { status: 502 }))

    await expect(createSessionsClient().list()).rejects.toThrow('the harness answered 502')
  })

  it('refuses an answer that is not a list of sessions', async () => {
    // A proxy that returns the dev server's index page with a 200 is the
    // usual way this happens, and "cannot read properties of undefined" is
    // not something to put in a header.
    answering(200, { hello: 'world' })

    await expect(createSessionsClient().list()).rejects.toThrow(/not a session list/)
  })

  it('lets go when the picker does', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      return new Response('{}')
    })

    await expect(createSessionsClient().list({ signal: controller.signal })).rejects.toThrow(
      /abort/i,
    )
  })
})

describe('starting a session', () => {
  it('posts, and answers with the new session', async () => {
    const { calls } = answering(201, { current: 'c', session: { id: 'c', events: 0 } })

    const id = await createSessionsClient().create()

    expect(calls[0]?.method).toBe('POST')
    expect(id).toBe('c')
  })

  it('refuses an answer that names no session', async () => {
    answering(201, { session: null })

    await expect(createSessionsClient().create()).rejects.toThrow('the harness named no session')
  })
})

describe('looking at a session', () => {
  it('is whatever the page was built with', () => {
    // Navigation by default; a test — or a future embedder — hands in its own,
    // which is the only reason the picker can be rendered without a browser.
    const opened: (string | undefined)[] = []
    const sessions = createSessionsClient({
      open: (id) => {
        opened.push(id)
      },
    })

    sessions.open('a')
    sessions.open(undefined)

    expect(opened).toEqual(['a', undefined])
  })
})
