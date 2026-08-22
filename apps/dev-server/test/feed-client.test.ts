/**
 * The feed, end to end: a real server, a real `EventSource`, and the feed
 * client that has only ever seen a fake one.
 *
 * Everything else about the client is tested by driving its transport by hand.
 * This file exists to check the one thing a fake cannot: that the frames the
 * server actually writes are the frames the client actually parses.
 *
 * `EventSource` is behind `--experimental-eventsource` on Node 22; the flag is
 * set for this project in `vitest.config.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionFeed } from '@harness/session-feed'
import type { SessionFeed } from '@harness/session-feed'
import { createHarnessServer, seedDemoEvents } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'

let harness: HarnessServer
let origin: string
const feeds: SessionFeed[] = []

beforeEach(async () => {
  harness = createHarnessServer({ heartbeatMs: 0 })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  for (const feed of feeds.splice(0)) feed.close()
  await harness.close()
})

/**
 * Open a feed client against the test server.
 *
 * @returns the feed, closed automatically when the test ends.
 */
function connect(): SessionFeed {
  const feed = createSessionFeed({ url: `${origin}/events` })
  feeds.push(feed)
  return feed
}

/**
 * Wait for a condition the network will eventually satisfy.
 *
 * @param label - what is being waited for, used in the failure message.
 * @param predicate - checked until it holds.
 */
async function until(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the feed client against a real server', () => {
  it('replays the whole log, then follows it live', async () => {
    seedDemoEvents(harness.log)
    const feed = connect()

    await until('history', () => feed.events.getSnapshot().length === 3)
    harness.log.append('demo/hello', { message: 'live' })
    await until('the live event', () => feed.events.getSnapshot().length === 4)

    const events = feed.events.getSnapshot()
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    expect(events.map((event) => event.type)).toEqual(harness.log.events.map((e) => e.type))
    expect(events[3]?.data).toEqual({ message: 'live' })
    expect(feed.status.getSnapshot()).toBe('open')
  })

  it('keeps the snapshot stable between changes', async () => {
    seedDemoEvents(harness.log)
    const feed = connect()
    await until('history', () => feed.events.getSnapshot().length === 3)

    const settled = feed.events.getSnapshot()

    expect(feed.events.getSnapshot()).toBe(settled)
    harness.log.append('demo/hello', { message: 'one more' })
    await until('the live event', () => feed.events.getSnapshot().length === 4)
    expect(feed.events.getSnapshot()).not.toBe(settled)
    expect(settled).toHaveLength(3)
  })

  it('shows two clients the same event without either one asking', async () => {
    const left = connect()
    const right = connect()
    await until('both connections', () => left.status.getSnapshot() === 'open' && right.status.getSnapshot() === 'open')

    harness.log.append('demo/hello', { from: 'the server' })

    await until('both replicas', () => {
      return left.events.getSnapshot().length === 1 && right.events.getSnapshot().length === 1
    })
    expect(left.events.getSnapshot()).toEqual(right.events.getSnapshot())
  })

  it('starts a late joiner from the beginning', async () => {
    seedDemoEvents(harness.log)
    const early = connect()
    await until('the early replica', () => early.events.getSnapshot().length === 3)

    harness.log.append('demo/hello', { message: 'after the fact' })
    await until('the early replica to catch up', () => early.events.getSnapshot().length === 4)

    // What a page refresh looks like from the server's side: a brand new
    // connection that has to be told everything.
    const late = connect()
    await until('the late replica', () => late.events.getSnapshot().length === 4)
    expect(late.events.getSnapshot()).toEqual(early.events.getSnapshot())
  })
})
