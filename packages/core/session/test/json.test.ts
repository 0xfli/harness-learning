import { describe, expect, it } from 'vitest'
import { deepFreeze, snapshotJsonValue } from '../src/json.ts'

describe('snapshotJsonValue', () => {
  it('passes JSON primitives through', () => {
    expect(snapshotJsonValue(null)).toBeNull()
    expect(snapshotJsonValue(true)).toBe(true)
    expect(snapshotJsonValue('hi')).toBe('hi')
    expect(snapshotJsonValue(0)).toBe(0)
    expect(snapshotJsonValue(-1.5)).toBe(-1.5)
  })

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 10n],
    ['a symbol', Symbol('nope')],
    ['a function', () => undefined],
    ['a Date', new Date()],
    ['a Set', new Set([1])],
  ])('rejects %s', (_label, value) => {
    expect(snapshotJsonValue(value)).toBeUndefined()
  })

  it('rejects a whole payload for one bad leaf', () => {
    expect(snapshotJsonValue({ ok: 1, bad: { deeper: 10n } })).toBeUndefined()
    expect(snapshotJsonValue([1, 2, () => undefined])).toBeUndefined()
  })

  it('deep-copies rather than sharing references', () => {
    const source = { nested: { list: [1, 2] } }

    const copy = snapshotJsonValue(source) as { nested: { list: number[] } }
    source.nested.list.push(3)

    expect(copy.nested.list).toEqual([1, 2])
    expect(copy.nested).not.toBe(source.nested)
  })

  it('keeps only own enumerable string keys', () => {
    const source = Object.create({ inherited: 'no' }) as Record<string, unknown>
    source.own = 'yes'
    Object.defineProperty(source, 'hidden', { value: 'no', enumerable: false })
    source[Symbol('sym') as unknown as string] = 'no'

    // A prototype other than Object.prototype is not a plain JSON record.
    expect(snapshotJsonValue(source)).toBeUndefined()
    expect(snapshotJsonValue({ ...source })).toEqual({ own: 'yes' })
  })

  it('accepts a null-prototype record', () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })

    expect(snapshotJsonValue(source)).toEqual({ a: 1 })
  })
})

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const frozen = deepFreeze({ nested: { list: [{ n: 1 }] } })

    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.nested)).toBe(true)
    expect(Object.isFrozen(frozen.nested.list)).toBe(true)
    expect(Object.isFrozen(frozen.nested.list[0])).toBe(true)
  })

  it('survives a cycle', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(Object.isFrozen(deepFreeze(cyclic))).toBe(true)
  })
})
