import { useSyncExternalStore } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@harness/session'

/**
 * The deliberate mistake of #2, kept as a test so the failure stays visible
 * rather than remembered.
 *
 * The data this store returns is correct. What is wrong is its identity: a
 * fresh array on every read tells React "the store changed" on every read, so
 * every render schedules another render.
 */
describe('a getSnapshot that allocates on every call', () => {
  it('re-renders until React gives up', () => {
    const log: SessionEvent[] = []
    const subscribe = (): (() => void) => () => {}
    const getSnapshot = (): readonly SessionEvent[] => [...log]

    function Naive(): number {
      return useSyncExternalStore(subscribe, getSnapshot).length
    }

    const complaints: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      complaints.push(args.map((arg) => String(arg)).join(' '))
    })

    let thrown: unknown
    try {
      render(<Naive />)
    } catch (error) {
      thrown = error
    }

    expect([...complaints, String(thrown)].join('\n')).toMatch(
      /getSnapshot should be cached|Maximum update depth/,
    )
  })

  it('is fixed by caching the array, which is what the feed client does', () => {
    const log: SessionEvent[] = []
    let cached: readonly SessionEvent[] | undefined
    const subscribe = (): (() => void) => () => {}
    const getSnapshot = (): readonly SessionEvent[] => (cached ??= Object.freeze(log.slice()))

    function Cached(): number {
      return useSyncExternalStore(subscribe, getSnapshot).length
    }

    expect(() => render(<Cached />)).not.toThrow()
  })
})
