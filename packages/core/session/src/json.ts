/**
 * Turning arbitrary input into something a ledger can hold: a deep JSON
 * snapshot, and a deep freeze.
 *
 * @module
 */

import type { JsonValue } from './types.ts'

/**
 * Freeze `value` and everything reachable from it.
 *
 * @param value - the value to freeze in place.
 * @returns the same reference, now deeply frozen.
 */
export function deepFreeze<T>(value: T): T {
  freezeInto(value, new WeakSet<object>())
  return value
}

function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return
  const object = value as object
  if (seen.has(object)) return
  seen.add(object)
  Object.freeze(object)
  for (const key of Reflect.ownKeys(object)) {
    freezeInto((object as Record<PropertyKey, unknown>)[key], seen)
  }
}

/**
 * Deep-copy `value` into plain JSON, or refuse.
 *
 * The copy matters as much as the check: the caller keeps its own object and
 * may go on mutating it, so the log must hold a detached snapshot rather than
 * a shared reference.
 *
 * Accepted: `null`, booleans, finite numbers, strings, arrays, and plain
 * objects. Own enumerable string-keyed properties whose value is `undefined`
 * are dropped, exactly as `JSON.stringify` drops them.
 *
 * Rejected: anything else — `undefined` at the root, `NaN`/`Infinity`,
 * `bigint`, symbols, functions, class instances, `Date`, `Map`, `Set`, and
 * cycles. A ledger that silently rewrites `NaN` to `null` or a `Date` to a
 * string is a ledger that lies about what it was told.
 *
 * @param value - the payload to snapshot.
 * @returns a detached JSON copy, or `undefined` when `value` is not JSON.
 */
export function snapshotJsonValue(value: unknown): JsonValue | undefined {
  return snapshot(value, new Set<object>())
}

function snapshot(value: unknown, path: Set<object>): JsonValue | undefined {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? value : undefined
    case 'object':
      break
    default:
      // undefined, bigint, symbol, function.
      return undefined
  }

  const object = value as object
  // Only a cycle is fatal; the same object appearing twice in sibling branches
  // is fine, so the marker is removed on the way back up.
  if (path.has(object)) return undefined
  path.add(object)
  try {
    if (Array.isArray(object)) {
      const copy: JsonValue[] = []
      for (const item of object as unknown[]) {
        const snapshotted = snapshot(item, path)
        if (snapshotted === undefined) return undefined
        copy.push(snapshotted)
      }
      return copy
    }
    if (!isPlainObject(object)) return undefined
    const copy: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) continue
      const snapshotted = snapshot(item, path)
      if (snapshotted === undefined) return undefined
      copy[key] = snapshotted
    }
    return copy
  } finally {
    path.delete(object)
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
