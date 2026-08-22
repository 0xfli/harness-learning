import { describe, expect, it, vi } from 'vitest'
import { createSessionFeed } from '../src/index.ts'
import type { FeedError, SessionFeed, SessionFeedOptions } from '../src/index.ts'
import { fakeTransport, wireEvent } from '../src/testing.ts'
import type { FakeTransport } from '../src/testing.ts'

/**
 * Build a feed over a hand-driven transport.
 *
 * @param options - overrides, e.g. a custom URL.
 * @returns the feed, its transport, and every error it contained.
 */
function connect(options: Omit<SessionFeedOptions, 'createSource'> = {}): {
  feed: SessionFeed
  transport: FakeTransport
  errors: FeedError[]
} {
  const transport = fakeTransport()
  const errors: FeedError[] = []
  const feed = createSessionFeed({
    createSource: transport.createSource,
    onError: (error) => errors.push(error),
    ...options,
  })
  return { feed, transport, errors }
}

describe('createSessionFeed', () => {
  it('opens the feed immediately, before anything subscribes', () => {
    const { transport } = connect()

    expect(transport.sources).toHaveLength(1)
    expect(transport.current().url).toBe('/events')
  })

  it('connects to the url it was given', () => {
    const { transport } = connect({ url: 'http://localhost:8787/events' })

    expect(transport.current().url).toBe('http://localhost:8787/events')
  })

  it('starts empty', () => {
    const { feed } = connect()

    expect(feed.events.getSnapshot()).toEqual([])
    expect(feed.status.getSnapshot()).toBe('connecting')
  })
})

describe('session feed snapshots', () => {
  it('replays history in seq order', () => {
    const { feed, transport } = connect()

    transport.current().send(wireEvent(0, 'demo/hello', { n: 1 }))
    transport.current().send(wireEvent(1, 'demo/hello', { n: 2 }))

    expect(feed.events.getSnapshot().map((event) => event.seq)).toEqual([0, 1])
    expect(feed.events.getSnapshot()[1]?.data).toEqual({ n: 2 })
  })

  // The contract behind `useSyncExternalStore`, and the mistake this package
  // exists to make impossible: a `getSnapshot` that allocates on every call
  // reports a change on every call, and React re-renders until it gives up.
  it('returns the same snapshot reference until the log grows', () => {
    const { feed, transport } = connect()

    const first = feed.events.getSnapshot()
    expect(feed.events.getSnapshot()).toBe(first)

    transport.current().send(wireEvent(0))
    const second = feed.events.getSnapshot()

    expect(second).not.toBe(first)
    expect(feed.events.getSnapshot()).toBe(second)
  })

  it('leaves an already-taken snapshot alone when new events arrive', () => {
    const { feed, transport } = connect()
    transport.current().send(wireEvent(0))
    const taken = feed.events.getSnapshot()

    transport.current().send(wireEvent(1))

    expect(taken).toHaveLength(1)
    expect(feed.events.getSnapshot()).toHaveLength(2)
  })

  it('hands out frozen events that a view cannot rewrite', () => {
    const { feed, transport } = connect()
    transport.current().send(wireEvent(0, 'demo/hello', { message: 'it happened' }))

    const snapshot = feed.events.getSnapshot()
    const event = snapshot[0]
    if (event === undefined) throw new Error('expected the event to be replicated')

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => {
      ;(event as { seq: number }).seq = 99
    }).toThrow(TypeError)
    expect(() => {
      ;(event.data as { message: string }).message = 'never happened'
    }).toThrow(TypeError)
  })
})

describe('session feed subscriptions', () => {
  it('notifies subscribers once per applied event', () => {
    const { feed, transport } = connect()
    const listener = vi.fn<() => void>()
    feed.events.subscribe(listener)

    transport.current().send(wireEvent(0))
    transport.current().send(wireEvent(1))

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying once a subscriber detaches', () => {
    const { feed, transport } = connect()
    const listener = vi.fn<() => void>()
    const unsubscribe = feed.events.subscribe(listener)

    transport.current().send(wireEvent(0))
    unsubscribe()
    transport.current().send(wireEvent(1))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('honours a detach that happens mid-notification', () => {
    const { feed, transport } = connect()
    const second = vi.fn<() => void>()
    let detachSecond: (() => void) | undefined
    feed.events.subscribe(() => detachSecond?.())
    detachSecond = feed.events.subscribe(second)

    transport.current().send(wireEvent(0))

    // The first subscriber detached the second before it was reached; React
    // unmounting a component mid-dispatch is exactly this shape.
    expect(second).not.toHaveBeenCalled()
  })

  it('contains a throwing subscriber and keeps the rest running', () => {
    const { feed, transport, errors } = connect()
    const healthy = vi.fn<() => void>()
    feed.events.subscribe(() => {
      throw new Error('render exploded')
    })
    feed.events.subscribe(healthy)

    transport.current().send(wireEvent(0))

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(feed.events.getSnapshot()).toHaveLength(1)
    expect(errors.map((error) => error.reason)).toEqual(['listener'])
  })

  it('keeps events and status on separate subscriptions', () => {
    const { feed, transport } = connect()
    const onEvents = vi.fn<() => void>()
    const onStatus = vi.fn<() => void>()
    feed.events.subscribe(onEvents)
    feed.status.subscribe(onStatus)

    transport.current().open()
    transport.current().send(wireEvent(0))

    // A new event must not wake the connection indicator, and vice versa.
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledTimes(1)
  })
})

describe('session feed status', () => {
  it('reports the connection lifecycle', () => {
    const { feed, transport } = connect()
    expect(feed.status.getSnapshot()).toBe('connecting')

    transport.current().open()
    expect(feed.status.getSnapshot()).toBe('open')

    transport.current().fail()
    expect(feed.status.getSnapshot()).toBe('reconnecting')

    transport.current().open()
    expect(feed.status.getSnapshot()).toBe('open')

    feed.close()
    expect(feed.status.getSnapshot()).toBe('closed')
  })

  it('stays quiet when the status has not changed', () => {
    const { feed, transport } = connect()
    const listener = vi.fn<() => void>()
    feed.status.subscribe(listener)

    transport.current().open()
    transport.current().open()

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('session feed ordering', () => {
  it('ignores an event it already holds', () => {
    const { feed, transport, errors } = connect()
    const listener = vi.fn<() => void>()
    feed.events.subscribe(listener)

    transport.current().send(wireEvent(0))
    // The overlap between a replayed history and the live tail is normal.
    transport.current().send(wireEvent(0))

    expect(feed.events.getSnapshot()).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('starts over when an event arrives ahead of its position', () => {
    const { feed, transport, errors } = connect()
    transport.current().send(wireEvent(0))
    const dropped = transport.current()

    dropped.send(wireEvent(2))

    // A hole cannot be rendered, so the replica is thrown away and rebuilt.
    expect(dropped.closed).toBe(true)
    expect(transport.sources).toHaveLength(2)
    expect(feed.events.getSnapshot()).toEqual([])
    expect(errors.map((error) => error.reason)).toEqual(['gap'])
  })

  it('starts over when a held position comes back with different content', () => {
    const { feed, transport, errors } = connect()
    transport.current().send(wireEvent(0, 'demo/hello'))
    transport.current().send(wireEvent(1, 'demo/hello'))
    const stale = transport.current()

    // What a server restarted with an empty log replays.
    stale.deliver(JSON.stringify({ seq: 0, type: 'demo/restarted', time: 1, data: {} }))

    expect(stale.closed).toBe(true)
    expect(feed.events.getSnapshot()).toEqual([])
    expect(errors.map((error) => error.reason)).toEqual(['divergence'])
  })

  it('rebuilds from scratch, so the new connection replays everything', () => {
    const { feed, transport } = connect()
    transport.current().send(wireEvent(1))

    // A fresh connection sends no Last-Event-ID, so history comes back whole.
    transport.current().send(wireEvent(0))
    transport.current().send(wireEvent(1))

    expect(feed.events.getSnapshot().map((event) => event.seq)).toEqual([0, 1])
  })

  it('announces the empty replica before reconnecting', () => {
    const { feed, transport } = connect()
    transport.current().send(wireEvent(0))
    const seen: number[] = []
    feed.events.subscribe(() => seen.push(feed.events.getSnapshot().length))

    transport.current().send(wireEvent(5))

    // No subscriber is ever left rendering a history already known to be wrong.
    expect(seen).toEqual([0])
  })
})

describe('session feed frame validation', () => {
  it.each([
    ['a non-string payload', { seq: 0, type: 'demo/hello', time: 1, data: {} }],
    ['a payload that is not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['a missing seq', '{"type":"demo/hello","time":1,"data":{}}'],
    ['a negative seq', '{"seq":-1,"type":"demo/hello","time":1,"data":{}}'],
    ['a fractional seq', '{"seq":1.5,"type":"demo/hello","time":1,"data":{}}'],
    ['an empty type', '{"seq":0,"type":"","time":1,"data":{}}'],
    ['a missing time', '{"seq":0,"type":"demo/hello","data":{}}'],
    ['array data', '{"seq":0,"type":"demo/hello","time":1,"data":[]}'],
    ['null data', '{"seq":0,"type":"demo/hello","time":1,"data":null}'],
  ])('reports and drops a frame with %s', (_label, payload) => {
    const { feed, transport, errors } = connect()
    const listener = vi.fn<() => void>()
    feed.events.subscribe(listener)

    transport.current().deliver(payload)

    expect(feed.events.getSnapshot()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    expect(errors.map((error) => error.reason)).toEqual(['malformed-frame'])
  })

  it('keeps working after a bad frame', () => {
    const { feed, transport } = connect()

    transport.current().deliver('{oops')
    transport.current().send(wireEvent(0))

    expect(feed.events.getSnapshot()).toHaveLength(1)
  })
})

describe('SessionFeed.close', () => {
  it('closes the transport and ignores anything that still arrives', () => {
    const { feed, transport } = connect()
    const source = transport.current()

    feed.close()
    source.send(wireEvent(0))

    expect(source.closed).toBe(true)
    expect(feed.events.getSnapshot()).toEqual([])
    expect(feed.status.getSnapshot()).toBe('closed')
  })

  it('is idempotent and stays closed when the transport errors afterwards', () => {
    const { feed, transport } = connect()
    const source = transport.current()

    feed.close()
    feed.close()
    source.fail()

    expect(feed.status.getSnapshot()).toBe('closed')
    expect(transport.sources).toHaveLength(1)
  })
})
