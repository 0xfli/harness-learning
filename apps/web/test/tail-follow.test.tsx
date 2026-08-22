import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'
import type { MountedInspector } from './helpers/inspector.tsx'

/**
 * Give the event stream a viewport, since jsdom lays nothing out.
 *
 * @param view - the mounted inspector.
 * @param scrollHeight - how tall the content pretends to be.
 * @param clientHeight - how much of it pretends to be visible.
 * @returns the scrolling element.
 */
function withViewport(view: MountedInspector, scrollHeight = 1000, clientHeight = 200): HTMLElement {
  const body = view.container.querySelector('.panel-body')
  if (body === null) throw new Error('the event stream has no body')
  Object.defineProperty(body, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: clientHeight, configurable: true })
  return body as HTMLElement
}

describe('the event stream tail', () => {
  it('follows the newest event', () => {
    const view = mountInspector()
    const body = withViewport(view)

    view.send(wireEvent(0), wireEvent(1))

    expect(body.scrollTop).toBe(1000)
  })

  it('stops following once the reader scrolls away', () => {
    const view = mountInspector()
    const body = withViewport(view)
    view.send(wireEvent(0))

    body.scrollTop = 0
    fireEvent.scroll(body)
    view.send(wireEvent(1))

    // Reading history is the one thing an auto-scrolling log makes impossible.
    expect(body.scrollTop).toBe(0)
  })

  it('resumes when the reader comes back to the bottom', () => {
    const view = mountInspector()
    const body = withViewport(view)
    view.send(wireEvent(0))
    body.scrollTop = 0
    fireEvent.scroll(body)
    view.send(wireEvent(1))

    // 1000 - 790 - 200 = 10px from the bottom: near enough to count.
    body.scrollTop = 790
    fireEvent.scroll(body)
    view.send(wireEvent(2))

    expect(body.scrollTop).toBe(1000)
  })
})
