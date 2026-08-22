import { describe, expect, it, vi } from 'vitest'
import { SessionLog } from '../src/index.ts'
import type { SessionEvent } from '../src/index.ts'

describe('SessionLog.append', () => {
  it('assigns dense, gapless, zero-based sequence numbers', () => {
    const log = new SessionLog()

    const first = log.append('demo/hello', { n: 1 })
    const second = log.append('demo/hello', { n: 2 })

    expect(first.seq).toBe(0)
    expect(second.seq).toBe(1)
    expect(log.length).toBe(2)
    expect(log.events.map((event) => event.seq)).toEqual([0, 1])
  })

  it('stamps the event with the injected clock', () => {
    const log = new SessionLog({ now: () => 1_700_000_000_000 })

    expect(log.append('demo/hello').time).toBe(1_700_000_000_000)
  })

  it('rejects an empty or non-string type', () => {
    const log = new SessionLog()

    expect(() => log.append('')).toThrow(TypeError)
    expect(() => log.append(42 as unknown as string)).toThrow(TypeError)
    expect(log.length).toBe(0)
  })

  it.each([
    ['a function', { fn: () => undefined }],
    ['a bigint', { big: 1n }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a Date', { at: new Date() }],
    ['a Map', { m: new Map() }],
    ['a class instance', { err: new Error('boom') }],
    ['a nested function', { nested: { deep: [() => undefined] } }],
  ])('rejects data containing %s', (_label, data) => {
    const log = new SessionLog()

    expect(() => log.append('demo/hello', data as never)).toThrow(TypeError)
    expect(log.length).toBe(0)
  })

  it('rejects a cyclic payload rather than looping forever', () => {
    const log = new SessionLog()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic

    expect(() => log.append('demo/hello', cyclic as never)).toThrow(TypeError)
    expect(log.length).toBe(0)
  })

  it('accepts the same object twice in sibling branches', () => {
    const log = new SessionLog()
    const shared = { id: 7 }

    const event = log.append('demo/hello', { left: shared, right: shared })

    expect(event.data).toEqual({ left: { id: 7 }, right: { id: 7 } })
  })

  it('drops undefined-valued properties, as JSON does', () => {
    const log = new SessionLog()

    const event = log.append('demo/hello', { kept: 1, dropped: undefined } as never)

    expect(Object.keys(event.data)).toEqual(['kept'])
  })

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'nope'],
    ['a number', 7],
  ])('rejects data that is %s rather than a record', (_label, data) => {
    const log = new SessionLog()

    expect(() => log.append('demo/hello', data as never)).toThrow(TypeError)
    expect(log.length).toBe(0)
  })

  it('defaults data to an empty record', () => {
    const log = new SessionLog()

    expect(log.append('demo/hello').data).toEqual({})
  })
})

describe('immutability', () => {
  it('refuses mutation of a previously appended event (a log is a ledger)', () => {
    const log = new SessionLog()
    log.append('demo/hello', { message: 'original', nested: { list: [1, 2] } })

    // The "deliberate mistake" this issue asks for: grab an already-appended
    // event somewhere else and try to rewrite history through it.
    const stolen = log.events[0] as SessionEvent
    const data = stolen.data as { message: string; nested: { list: number[] } }

    expect(() => {
      data.message = 'tampered'
    }).toThrow(TypeError)
    expect(() => {
      data.nested.list.push(3)
    }).toThrow(TypeError)
    expect(() => {
      ;(stolen as { seq: number }).seq = 99
    }).toThrow(TypeError)

    expect(log.events[0]?.data).toEqual({ message: 'original', nested: { list: [1, 2] } })
    expect(log.events[0]?.seq).toBe(0)
  })

  it('detaches the stored payload from the caller-owned object', () => {
    const log = new SessionLog()
    const payload: { message: string; tags: string[] } = { message: 'before', tags: ['a'] }

    const event = log.append('demo/hello', payload)
    payload.message = 'after'
    payload.tags.push('b')

    expect(event.data).toEqual({ message: 'before', tags: ['a'] })
  })

  it('hands out a frozen history snapshot that later appends do not touch', () => {
    const log = new SessionLog()
    log.append('demo/hello', { n: 1 })

    const snapshot = log.events
    log.append('demo/hello', { n: 2 })

    expect(snapshot).toHaveLength(1)
    expect(log.events).toHaveLength(2)
    expect(() => (snapshot as SessionEvent[]).push(log.events[1] as SessionEvent)).toThrow(TypeError)
  })
})

describe('reading the log', () => {
  it('returns the tail from a given seq', () => {
    const log = new SessionLog()
    for (let n = 0; n < 4; n += 1) log.append('demo/hello', { n })

    expect(log.since(2).map((event) => event.seq)).toEqual([2, 3])
    expect(log.since(-5)).toHaveLength(4)
    expect(log.since(99)).toHaveLength(0)
  })

  it('looks one event up by seq', () => {
    const log = new SessionLog()
    log.append('demo/hello', { n: 0 })

    expect(log.at(0)?.data).toEqual({ n: 0 })
    expect(log.at(1)).toBeUndefined()
  })
})

describe('observers', () => {
  it('commits before it broadcasts', () => {
    const log = new SessionLog()
    const seenLengths: number[] = []
    log.observe((event) => {
      // The event that woke the observer must already be readable in the log.
      seenLengths.push(log.length)
      expect(log.at(event.seq)).toBe(event)
    })

    log.append('demo/hello', { n: 1 })
    log.append('demo/hello', { n: 2 })

    expect(seenLengths).toEqual([1, 2])
  })

  it('delivers the same event to every simultaneous observer', () => {
    const log = new SessionLog()
    const first: SessionEvent[] = []
    const second: SessionEvent[] = []
    log.observe((event) => first.push(event))
    log.observe((event) => second.push(event))

    const appended = log.append('demo/hello', { message: 'broadcast' })

    expect(first).toEqual([appended])
    expect(second).toEqual([appended])
    expect(first[0]).toBe(second[0])
  })

  it('gives a late subscriber history then live events, with no gaps or duplicates', () => {
    const log = new SessionLog()
    log.append('demo/hello', { n: 0 })
    log.append('demo/hello', { n: 1 })

    // History and subscription are read in the same tick, so nothing can slip
    // in between them.
    const received = [...log.events]
    const unobserve = log.observe((event) => received.push(event))
    log.append('demo/hello', { n: 2 })
    log.append('demo/hello', { n: 3 })
    unobserve()

    expect(received.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    expect(new Set(received).size).toBe(4)
  })

  it('stops delivering after unobserve, including mid-dispatch', () => {
    const log = new SessionLog()
    const seen: number[] = []
    const late: number[] = []
    // Registered first, so it runs first and can detach the second observer
    // before the same dispatch ever reaches it.
    let unobserveLate = (): void => undefined
    const unobserveFirst = log.observe((event) => {
      seen.push(event.seq)
      unobserveLate()
    })
    unobserveLate = log.observe((event) => late.push(event.seq))

    log.append('demo/hello')
    log.append('demo/hello')
    unobserveFirst()
    log.append('demo/hello')

    expect(late).toEqual([])
    expect(seen).toEqual([0, 1])
  })

  it('does not deliver an event to an observer registered during its dispatch', () => {
    const log = new SessionLog()
    const nested: number[] = []
    const unobserve = log.observe(() => {
      log.observe((event) => nested.push(event.seq))
    })

    log.append('demo/hello')
    unobserve()
    log.append('demo/hello')

    expect(nested).toEqual([1])
  })

  it('contains a throwing observer instead of failing the committed append', () => {
    const onObserverError = vi.fn()
    const log = new SessionLog({ onObserverError })
    const survivor: number[] = []
    log.observe(() => {
      throw new Error('observer exploded')
    })
    log.observe((event) => survivor.push(event.seq))

    const event = log.append('demo/hello')

    expect(log.length).toBe(1)
    expect(survivor).toEqual([0])
    expect(onObserverError).toHaveBeenCalledOnce()
    expect(onObserverError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(onObserverError.mock.calls[0]?.[1]).toBe(event)
  })

  it('rejects an append made from inside an observer', () => {
    const onObserverError = vi.fn()
    const log = new SessionLog({ onObserverError })
    log.observe(() => {
      log.append('demo/reentrant')
    })

    log.append('demo/hello')

    // The reentrant append threw, so it never reached the log.
    expect(log.length).toBe(1)
    expect(log.events.map((event) => event.type)).toEqual(['demo/hello'])
    expect(onObserverError).toHaveBeenCalledOnce()
    expect(String(onObserverError.mock.calls[0]?.[0])).toMatch(/inside a session observer/)
  })

  it('accepts appends again once the broadcast is over', () => {
    const log = new SessionLog({ onObserverError: () => undefined })
    const unobserve = log.observe(() => {
      log.append('demo/reentrant')
    })

    log.append('demo/hello')
    unobserve()
    log.append('demo/later')

    expect(log.events.map((event) => event.type)).toEqual(['demo/hello', 'demo/later'])
  })

  it('still lets appends through after an observer throws', () => {
    const log = new SessionLog({ onObserverError: () => undefined })
    log.observe(() => {
      throw new Error('observer exploded')
    })

    log.append('demo/hello')
    log.append('demo/hello')

    expect(log.length).toBe(2)
  })

  it('rejects a non-function observer', () => {
    const log = new SessionLog()

    expect(() => log.observe(undefined as never)).toThrow(TypeError)
    expect(log.observerCount).toBe(0)
  })
})
