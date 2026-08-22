import { describe, expect, it } from 'vitest'
import { within } from '@testing-library/react'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'
import type { MountedInspector } from './helpers/inspector.tsx'

/**
 * Every event row as one line of text.
 *
 * @param view - the mounted inspector.
 * @returns the visible stream, top to bottom.
 */
function stream(view: MountedInspector): string[] {
  return [...view.container.querySelectorAll('.event-row')].map((row) =>
    [...row.children].map((cell) => cell.textContent).join(' '),
  )
}

describe('the inspector shell', () => {
  it('is three columns over one log', () => {
    const view = mountInspector()
    const scope = within(view.container)

    expect(
      [...view.container.querySelectorAll('.panel')].map((panel) =>
        panel.getAttribute('aria-label'),
      ),
    ).toEqual(['Event stream', 'Conversation', 'Model view'])
    // All three columns read the log now, and the middle one can be written
    // to.
    expect(scope.getByLabelText('Conversation').querySelector('.composer')).not.toBeNull()
    expect(scope.getByLabelText('Model view').textContent).toContain('derived from the same log')
  })

  it('says so when the log is empty', () => {
    const view = mountInspector()

    expect(stream(view)).toEqual([])
    expect(view.container.querySelector('.panel-placeholder')?.textContent).toBe(
      'waiting for the first event',
    )
  })
})

describe('the event stream', () => {
  it('renders one line per event, oldest first', () => {
    const view = mountInspector()

    view.send(wireEvent(0, 'demo/hello', { message: 'the log exists' }), wireEvent(1, 'demo/bye'))

    expect(stream(view)).toEqual([
      '0 22:13:20.000 demo/hello {"message":"the log exists"}',
      '1 22:13:20.001 demo/bye ',
    ])
  })

  it('counts what it is showing', () => {
    const view = mountInspector()
    const note = () => view.container.querySelector('.panel-note')?.textContent

    view.send(wireEvent(0))
    expect(note()).toBe('1 event')

    view.send(wireEvent(1))
    expect(note()).toBe('2 events')
  })

  it('appends a newly arriving event to what is already there', () => {
    const view = mountInspector()
    view.send(wireEvent(0, 'demo/hello'))

    view.send(wireEvent(1, 'demo/hello'))

    expect(stream(view)).toHaveLength(2)
  })

  it('tags each row with its seq and type for the eye and the tests', () => {
    const view = mountInspector()

    view.send(wireEvent(0, 'demo/hello'))

    const row = view.container.querySelector('.event-row')
    expect(row?.getAttribute('data-seq')).toBe('0')
    expect(row?.getAttribute('data-type')).toBe('demo/hello')
  })
})

describe('reloading the page', () => {
  it('reproduces it exactly, because the log replays', () => {
    const history = [
      wireEvent(0, 'demo/hello', { message: 'the log exists' }),
      wireEvent(1, 'demo/hello', { message: 'facts go in, in order' }),
      wireEvent(2, 'demo/bye'),
    ]

    const before = mountInspector()
    before.open()
    before.send(...history)
    const rendered = before.container.innerHTML

    // A refresh is a new page over a new connection, and the server replays
    // the whole log to it. Nothing survives in the client between the two.
    const after = mountInspector()
    after.open()
    after.send(...history)

    expect(after.container.innerHTML).toBe(rendered)
  })
})

describe('two tabs', () => {
  it('show the same newly appended event', () => {
    const left = mountInspector()
    const right = mountInspector()

    // One append, broadcast to every open connection: the server's job, and
    // the reason neither tab has to poll or be told to refresh.
    left.send(wireEvent(0, 'demo/hello', { from: 'curl' }))
    right.send(wireEvent(0, 'demo/hello', { from: 'curl' }))

    expect(stream(left)).toEqual(stream(right))
    expect(stream(left)).toEqual(['0 22:13:20.000 demo/hello {"from":"curl"}'])
  })
})

describe('the connection indicator', () => {
  it('follows the feed, not the log', () => {
    const view = mountInspector()
    const status = () => view.container.querySelector('.connection-status')

    expect(status()?.textContent).toBe('connecting')
    expect(status()?.getAttribute('data-status')).toBe('connecting')

    view.open()
    expect(status()?.textContent).toBe('live')

    view.close()
    expect(status()?.textContent).toBe('closed')
  })
})
