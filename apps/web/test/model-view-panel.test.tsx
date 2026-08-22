/**
 * The right column, mounted.
 *
 * The claim under test is narrow and worth stating plainly: this column is not
 * a description of the request, it is the request. So the assertions compare
 * its text with `deriveMessages` — the same fold the server runs to build one
 * — and with the literal JSON a provider would receive.
 *
 * The second claim is what the three columns are for. While a reply streams,
 * the middle column fills in and this one does not move: deltas are facts
 * about the process, and the request was settled before the first one arrived.
 */

import { describe, expect, it } from 'vitest'
import { within } from '@testing-library/react'
import { deriveMessages } from '@harness/exchange'
import type { SessionEvent } from '@harness/session'
import { modelViewJson } from '../src/model-view.ts'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'
import type { MountedInspector } from './helpers/inspector.tsx'

type WireEvent = ReturnType<typeof wireEvent>

function column(view: MountedInspector): HTMLElement {
  return within(view.container).getByLabelText('Model view')
}

/** Exactly what the column is painting, punctuation and all. */
function request(view: MountedInspector): string {
  return column(view).querySelector('.model-json')?.textContent ?? ''
}

/** What the same events fold to, computed independently of the DOM. */
function derived(events: readonly WireEvent[]): string {
  return modelViewJson(deriveMessages(events as unknown as readonly SessionEvent[]))
}

/** The events one exchange produces, as the server would frame them. */
function exchangeEvents(id: string, said: string, deltas: readonly string[]) {
  const events: WireEvent[] = [wireEvent(0, 'user/message', { id, text: said })]
  deltas.forEach((text, index) => {
    events.push(wireEvent(events.length, 'assistant/chunk', { id, index, text }))
  })
  return {
    all: events,
    finish: (): WireEvent =>
      wireEvent(events.length, 'assistant/message', {
        id,
        text: deltas.join(''),
        reason: 'stop',
        chunks: deltas.length,
      }),
  }
}

describe('the model view column', () => {
  it('says so when there is nothing to send', () => {
    const view = mountInspector()

    expect(column(view).textContent).toContain('nothing to send yet')
    expect(column(view).querySelector('.model-json')).toBeNull()
  })

  it('shows the request itself, as a provider receives it', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi', ' there'])

    view.send(...script.all, script.finish())

    expect(request(view)).toBe(
      `[
  {
    "role": "user",
    "content": "hello"
  },
  {
    "role": "assistant",
    "content": "hi there"
  }
]`,
    )
  })

  it('agrees with the fold the server builds a request with', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi', ' there'])
    const all = [...script.all, script.finish()]

    view.send(...all)

    // The same function over the same events. If these two ever disagree,
    // something between the log and the screen has started editing the
    // conversation.
    expect(request(view)).toBe(derived(all))
  })

  it('counts messages, not events', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['one', ' two', ' three'])
    const note = () => column(view).querySelector('.panel-note')?.textContent

    view.send(...script.all)
    expect(note()).toBe('1 message')

    view.send(script.finish())
    expect(note()).toBe('2 messages')
  })

  it('tags each message with its role, so a turn keeps its colour across the columns', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi'])

    view.send(...script.all, script.finish())

    expect(
      [...column(view).querySelectorAll('.model-message')].map((block) =>
        block.getAttribute('data-role'),
      ),
    ).toEqual(['user', 'assistant'])
  })

  it('ignores a kind of fact nobody taught it about', () => {
    const view = mountInspector()

    view.send(
      wireEvent(0, 'user/message', { id: 'a', text: 'hello' }),
      wireEvent(1, 'demo/hello', { message: 'not part of the conversation' }),
    )

    expect(request(view)).toBe(`[
  {
    "role": "user",
    "content": "hello"
  }
]`)
  })
})

describe('while a reply is streaming', () => {
  it('shows exactly the request that produced it, and does not move', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi', ' there', ' friend'])

    view.send(script.all[0] as WireEvent)
    const atRequestTime = request(view)

    view.send(...script.all.slice(1))

    // Thirty deltas or three, the request is what it was when it was made.
    expect(request(view)).toBe(atRequestTime)
    expect(request(view)).toBe(`[
  {
    "role": "user",
    "content": "hello"
  }
]`)
  })

  it('grows only when the assembled reply lands', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi', ' there'])
    view.send(...script.all)

    view.send(script.finish())

    expect(column(view).querySelectorAll('.model-message')).toHaveLength(2)
  })
})

describe('a reply that never finished', () => {
  it('is on screen for the human and absent from the request', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['half a th'])

    view.send(
      ...script.all,
      wireEvent(script.all.length, 'error/stream', {
        id: 'a',
        message: 'provider hung up',
        chunks: 1,
      }),
    )

    // The two columns disagree, on purpose and in public. The human saw an
    // attempt that broke off; the model is never told it said half a word,
    // because the log never called that reply finished. ADR-0006 argues it.
    const conversation = within(view.container).getByLabelText('Conversation')
    expect(conversation.querySelector('.turn[data-state="failed"]')?.textContent).toContain(
      'half a th',
    )
    expect(request(view)).toBe(`[
  {
    "role": "user",
    "content": "hello"
  }
]`)
  })
})
