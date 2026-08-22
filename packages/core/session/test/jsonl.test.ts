import { describe, expect, it } from 'vitest'
import { SessionLog } from '../src/index.ts'
import { asSessionEvent, decodeEvent, encodeEvent } from '../src/jsonl.ts'

const EVENT = { seq: 0, type: 'demo/hello', time: 1_700_000_000_000, data: { n: 1 } }

describe('encodeEvent', () => {
  it('writes one line, terminator included', () => {
    const line = encodeEvent(EVENT)

    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
  })

  it('escapes newlines in the payload, so a line break is always a boundary', () => {
    const log = new SessionLog()
    const event = log.append('user/message', { text: 'first\nsecond' })

    expect(encodeEvent(event).split('\n')).toHaveLength(2)
    expect(decodeEvent(encodeEvent(event).trimEnd())?.data['text']).toBe('first\nsecond')
  })
})

describe('decodeEvent', () => {
  it('round-trips to the same bytes', () => {
    const line = encodeEvent(EVENT)

    const decoded = decodeEvent(line.trimEnd())

    expect(decoded).toEqual(EVENT)
    expect(encodeEvent(decoded as never)).toBe(line)
  })

  it('deep-freezes what it reads', () => {
    const decoded = decodeEvent('{"seq":0,"type":"t","time":1,"data":{"nested":{"n":1}}}')

    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded?.data['nested'])).toBe(true)
  })

  it.each([
    ['blank', '   '],
    ['truncated', '{"seq":0,"type":"demo/hel'],
    ['not JSON', 'hello'],
    ['an array', '[0,"t",1,{}]'],
    ['null', 'null'],
    ['a negative seq', '{"seq":-1,"type":"t","time":1,"data":{}}'],
    ['a fractional seq', '{"seq":0.5,"type":"t","time":1,"data":{}}'],
    ['an empty type', '{"seq":0,"type":"","time":1,"data":{}}'],
    ['a missing time', '{"seq":0,"type":"t","data":{}}'],
    ['array data', '{"seq":0,"type":"t","time":1,"data":[]}'],
    ['null data', '{"seq":0,"type":"t","time":1,"data":null}'],
    // A field this reader has never heard of means the line was written by
    // something else. Dropping it silently would report a fact it cannot read
    // as a fact it read.
    ['an unknown field', '{"seq":0,"type":"t","time":1,"data":{},"actor":"me"}'],
  ])('refuses a line that is %s', (_label, line) => {
    expect(decodeEvent(line)).toBeUndefined()
  })
})

describe('asSessionEvent', () => {
  it('accepts an event whatever order its keys arrived in', () => {
    const decoded = asSessionEvent({ data: {}, time: 1, type: 't', seq: 0 })

    // Rebuilt in canonical order, so re-encoding is stable no matter who
    // wrote the file.
    expect(decoded).toBeDefined()
    expect(Object.keys(decoded as object)).toEqual(['seq', 'type', 'time', 'data'])
  })
})
