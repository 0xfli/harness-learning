import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetThemeStore, setThemeChoice } from '../src/theme-store.ts'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'

// The other two columns are replaced by counters. They render nothing, so the
// only thing they can report is how many times React called them — and the
// question is about everything *between* the store and a column: does an event
// wake the shell, the header, or the connection indicator, none of which asked
// for one? Each column subscribing for itself is the point; a page that
// re-renders as a whole is what this guards against.
const renders = vi.hoisted(() => ({ conversation: 0, modelView: 0 }))

vi.mock('../src/panels/conversation-panel.tsx', () => ({
  ConversationPanel: () => {
    renders.conversation += 1
    return null
  },
}))

vi.mock('../src/panels/model-view-panel.tsx', () => ({
  ModelViewPanel: () => {
    renders.modelView += 1
    return null
  },
}))

describe('an arriving event', () => {
  it('re-renders the event stream and nothing else', () => {
    const view = mountInspector()
    view.open()
    view.send(wireEvent(0, 'demo/hello'))
    const settled = { ...renders }

    view.send(wireEvent(1, 'demo/hello'), wireEvent(2, 'demo/hello'))

    expect(view.container.querySelectorAll('.event-row')).toHaveLength(3)
    expect(renders).toEqual(settled)
  })
})

describe('a connection change', () => {
  it('re-renders the indicator and nothing else', () => {
    const view = mountInspector()
    view.send(wireEvent(0, 'demo/hello'))
    const settled = { ...renders }

    view.open()

    expect(view.container.querySelector('.connection-status')?.textContent).toBe('live')
    expect(renders).toEqual(settled)
  })
})

describe('the shell itself', () => {
  it('renders once and then stays out of the way', () => {
    const view = mountInspector()
    const afterMount = { ...renders }

    view.open()
    view.send(wireEvent(0), wireEvent(1), wireEvent(2), wireEvent(3))

    // Nothing is threaded through App as props, so App has nothing to
    // re-render for. Hoisting the event array into App would break this and
    // nothing else — which is exactly why it is a test.
    expect(renders).toEqual(afterMount)
  })
})

describe('a change of colour scheme', () => {
  afterEach(resetThemeStore)

  it('re-renders the toggle and nothing else', () => {
    const view = mountInspector()
    const settled = { ...renders }

    act(() => {
      setThemeChoice('dark')
    })

    // The colour scheme is the one piece of UI state on the page, and it is
    // held outside React for this reason. A `useState` in App — or a provider
    // above the columns holding it — would repaint all three columns every
    // time somebody flipped the theme, and would break exactly this.
    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(view.container.querySelector('.theme-toggle')).not.toBeNull()
    expect(renders).toEqual(settled)
  })
})
