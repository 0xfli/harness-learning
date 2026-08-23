/**
 * The picker, which is the only part of "load a session on demand" a human
 * ever touches.
 *
 * Two behaviours are worth pinning down and neither is about rendering. One:
 * the run's own session is chosen by *not* naming it, so a page left on the
 * current session keeps following the harness across a restart. Two: an id
 * that is not on the shelf still appears in the control, because a page that
 * silently shows a different session than its URL claims is worse than one
 * admitting it cannot find the log.
 */

import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionCatalogue } from '../src/sessions-client.ts'
import { mountInspector } from './helpers/inspector.tsx'

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)

const shelf: SessionCatalogue = {
  current: 'b',
  sessions: [
    { id: 'b', events: 0, startedAt: undefined, updatedAt: undefined, title: undefined },
    {
      id: 'a',
      events: 12,
      startedAt: NOW - 7_200_000,
      updatedAt: NOW - 3_600_000,
      title: 'what is a harness?',
    },
  ],
}

/** Look at the page as if it had been opened at this URL. */
function pinTo(id: string | undefined): void {
  const search = id === undefined ? '' : `?session=${id}`
  globalThis.history.replaceState({}, '', `/${search}`)
}

function select(view: { container: HTMLElement }): HTMLSelectElement {
  const found = view.container.querySelector('.session-select')
  if (found === null) throw new Error('the header has no session picker')
  return found as HTMLSelectElement
}

function options(view: { container: HTMLElement }): string[] {
  return [...select(view).options].map((option) => option.textContent ?? '')
}

afterEach(() => {
  pinTo(undefined)
  vi.useRealTimers()
})

describe('a page that has not been answered yet', () => {
  it('says so rather than pretending the shelf is empty', () => {
    const view = mountInspector()

    expect(select(view).disabled).toBe(true)
    expect(options(view)).toEqual(['reading the shelf…'])
  })

  it('does not name a session it has not heard of', () => {
    const view = mountInspector()

    expect(view.shelf.opened).toEqual([])
  })
})

describe('the sessions on the shelf', () => {
  it('are listed by what they were about and when they last moved', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const view = mountInspector()

    await view.shelf.answer(shelf)

    expect(options(view)).toEqual([
      'nothing said yet · empty · 0 events · this run',
      'what is a harness? · 1h ago · 12 events',
    ])
  })

  it('start on the one this run is using', async () => {
    const view = mountInspector()

    await view.shelf.answer(shelf)

    expect(select(view).value).toBe('b')
  })

  it('start on the one the URL named', async () => {
    pinTo('a')
    const view = mountInspector()

    await view.shelf.answer(shelf)

    expect(select(view).value).toBe('a')
  })
})

describe('choosing an older session', () => {
  it('opens it by name', async () => {
    const view = mountInspector()
    await view.shelf.answer(shelf)

    fireEvent.change(select(view), { target: { value: 'a' } })

    expect(view.shelf.opened).toEqual(['a'])
  })
})

describe('choosing the session this run started', () => {
  it('opens it by not naming it', async () => {
    // The id would work today and be stale tomorrow: the next run starts a
    // session of its own, and a URL pinned to this one would keep showing a
    // log nothing is appending to. Naming nothing is what "follow the run"
    // looks like in a URL.
    pinTo('a')
    const view = mountInspector()
    await view.shelf.answer(shelf)

    fireEvent.change(select(view), { target: { value: 'b' } })

    expect(view.shelf.opened).toEqual([undefined])
  })
})

describe('a URL naming a session that is not on the shelf', () => {
  it('shows it anyway, and says what is wrong with it', async () => {
    pinTo('deleted')
    const view = mountInspector()

    await view.shelf.answer(shelf)

    expect(select(view).value).toBe('deleted')
    expect(options(view)[0]).toBe('deleted · not on the shelf')
  })
})

describe('starting a new session', () => {
  it('asks the harness for one and looks at it', async () => {
    const view = mountInspector()
    await view.shelf.answer(shelf)

    fireEvent.click(view.getByRole('button', { name: 'new' }))
    expect(view.shelf.starts).toBe(1)
    // The button stays down while the request is out, so an impatient second
    // press cannot start a second session nobody asked for.
    expect((view.getByRole('button', { name: 'new' }) as HTMLButtonElement).disabled).toBe(true)

    await view.shelf.started('c')

    // A new session is the run's session, so the page follows the run.
    expect(view.shelf.opened).toEqual([undefined])
  })
})

describe('a shelf that cannot be reached', () => {
  it('reports it in the control instead of blanking the header', async () => {
    const view = mountInspector()

    await view.shelf.refuse('the harness answered 502')

    expect(select(view).disabled).toBe(true)
    expect(options(view)).toEqual(['no shelf: the harness answered 502'])
  })

  it('leaves the rest of the page working', async () => {
    // The picker is a convenience over a URL. Losing it must not cost the
    // three columns, which are already replicating a log that arrived.
    const view = mountInspector()
    view.open()

    await view.shelf.refuse('nope')

    expect(view.container.querySelector('.connection-status')?.textContent).toBe('live')
  })
})
