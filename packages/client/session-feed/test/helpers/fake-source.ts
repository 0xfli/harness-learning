/**
 * A hand-driven stand-in for `EventSource`: the feed client's transport, with
 * the network replaced by test code that decides exactly what arrives and
 * when.
 *
 * @module
 */

import type { FeedSource, FeedSourceFactory, FeedSourceMessage } from '../../src/index.ts'

/** One connection the feed client opened. */
export class FakeSource implements FeedSource {
  readonly url: string
  /** True once the feed client closed this connection. */
  closed = false

  readonly #listeners = new Map<string, Set<(event: FeedSourceMessage) => void>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(
    type: 'open' | 'error' | 'message',
    listener: (event: FeedSourceMessage) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  close(): void {
    this.closed = true
  }

  /** The connection came up. */
  open(): void {
    this.#emit('open', {})
  }

  /** The connection dropped. `EventSource` would now be retrying. */
  fail(): void {
    this.#emit('error', {})
  }

  /** Deliver one raw frame payload, byte for byte. */
  deliver(data: unknown): void {
    this.#emit('message', { data })
  }

  /** Deliver one event the way the server would frame it. */
  send(event: { seq: number; type: string; time: number; data?: unknown }): void {
    this.deliver(JSON.stringify({ data: {}, ...event }))
  }

  #emit(type: string, event: FeedSourceMessage): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

/** Every connection the feed client opens, in order, plus the factory. */
export interface FakeTransport {
  readonly sources: readonly FakeSource[]
  readonly createSource: FeedSourceFactory
  /** The connection currently in use. */
  current(): FakeSource
}

/**
 * Build a transport that records every connection the feed client opens.
 *
 * @returns the factory to hand to `createSessionFeed`, and the connections it
 *   produced — a resync is visible as a second entry.
 */
export function fakeTransport(): FakeTransport {
  const sources: FakeSource[] = []
  return {
    sources,
    createSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    current: () => {
      const source = sources.at(-1)
      if (source === undefined) throw new Error('no connection was opened')
      return source
    },
  }
}

/**
 * Build an event the way the server would.
 *
 * @param seq - the position, which is also the SSE id.
 * @param type - the event type.
 * @param data - the payload.
 * @returns a wire-shaped event.
 */
export function wireEvent(
  seq: number,
  type = 'demo/hello',
  data: Record<string, unknown> = {},
): { seq: number; type: string; time: number; data: Record<string, unknown> } {
  return { seq, type, time: 1_700_000_000_000 + seq, data }
}
