import { describe, expect, it, vi } from 'vitest'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'

// The two idle columns are replaced by counters. They render nothing, so the
// only thing they can report is how many times React called them — which is
// the whole question: does an event that only the event stream cares about
// wake anything else on the page?
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
