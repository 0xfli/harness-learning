/**
 * The middle column, mounted.
 *
 * Every assertion here is about the same claim from a different angle: the
 * conversation is a function of the event array. Nothing is appended, nothing
 * is remembered between renders, and the one thing that is not in the log yet
 * — the message just sent — is added by a pure reducer and dropped again by
 * the same one.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { within } from '@testing-library/react'
import { mountInspector, wireEvent } from './helpers/inspector.tsx'
import type { MountedInspector } from './helpers/inspector.tsx'

/** Each rendered bubble as `role · state · text`. */
function turns(view: MountedInspector): string[] {
  return [...view.container.querySelectorAll('.turn')].map((turn) => {
    const state = turn.getAttribute('data-state')
    const text = turn.querySelector('.turn-text')?.textContent ?? ''
    return `${turn.getAttribute('data-role')} · ${state} · ${text}`
  })
}

function conversation(view: MountedInspector): HTMLElement {
  return within(view.container).getByLabelText('Conversation')
}

function sentId(view: MountedInspector, index = 0): string {
  const message = view.exchanges.sent[index]
  if (message === undefined) throw new Error(`nothing was sent at ${index}`)
  return message.id
}

/** The events one exchange produces, as the server would frame them. */
function exchangeEvents(id: string, said: string, deltas: readonly string[]) {
  const events = [wireEvent(0, 'user/message', { id, text: said })]
  deltas.forEach((text, index) => {
    events.push(wireEvent(events.length, 'assistant/chunk', { id, index, text }))
  })
  return {
    all: events,
    finish: () =>
      wireEvent(events.length, 'assistant/message', {
        id,
        text: deltas.join(''),
        reason: 'stop',
        chunks: deltas.length,
      }),
  }
}

describe('the conversation column', () => {
  it('says so when nothing has been said', () => {
    const view = mountInspector()

    expect(turns(view)).toEqual([])
    expect(conversation(view).textContent).toContain('nothing has been said yet')
  })

  it('renders a bubble per turn, oldest first', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['hi', ' there'])

    view.send(...script.all, script.finish())

    expect(turns(view)).toEqual(['user · complete · hello', 'assistant · complete · hi there'])
  })

  it('counts the turns, not the events', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['one', ' two', ' three'])

    view.send(...script.all)

    expect(conversation(view).querySelector('.panel-note')?.textContent).toBe('2 turns')
  })
})

describe('a reply arriving', () => {
  it('appears progressively, one delta at a time', () => {
    const view = mountInspector()
    const id = 'a'
    const reply = () => view.container.querySelector('.turn[data-role="assistant"]')

    view.send(wireEvent(0, 'user/message', { id, text: 'hello' }))
    expect(reply()).toBeNull()

    view.send(wireEvent(1, 'assistant/chunk', { id, index: 0, text: 'It ' }))
    expect(reply()?.querySelector('.turn-text')?.textContent).toBe('It ')

    view.send(wireEvent(2, 'assistant/chunk', { id, index: 1, text: 'was ' }))
    expect(reply()?.querySelector('.turn-text')?.textContent).toBe('It was ')

    view.send(wireEvent(3, 'assistant/chunk', { id, index: 2, text: 'derived.' }))
    expect(reply()?.querySelector('.turn-text')?.textContent).toBe('It was derived.')
  })

  it('is marked as still running until the assembled message lands', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['half', ' of it'])

    view.send(...script.all)
    expect(turns(view)).toEqual(['user · complete · hello', 'assistant · streaming · half of it'])

    view.send(script.finish())
    expect(turns(view)).toEqual(['user · complete · hello', 'assistant · complete · half of it'])
  })

  it('shows no caret character in the text it renders', () => {
    const view = mountInspector()
    const script = exchangeEvents('a', 'hello', ['typing'])

    view.send(...script.all)

    // The blinking caret is a CSS pseudo-element keyed on `data-state`. Were
    // it a character, it would be a character somebody appended — which is
    // precisely the code this step is about not writing.
    expect(
      view.container.querySelector('.turn[data-role="assistant"] .turn-text')?.textContent,
    ).toBe('typing')
  })

  it('keeps what did arrive when the stream breaks, and says why', () => {
    const view = mountInspector()
    const id = 'a'

    view.send(
      wireEvent(0, 'user/message', { id, text: 'hello' }),
      wireEvent(1, 'assistant/chunk', { id, index: 0, text: 'half a sen' }),
      wireEvent(2, 'error/stream', { id, message: 'provider hung up', chunks: 1 }),
    )

    expect(turns(view)).toEqual(['user · complete · hello', 'assistant · failed · half a sen'])
    expect(view.container.querySelector('.turn-error')?.textContent).toBe('provider hung up')
  })
})

describe('sending a message', () => {
  it('shows it the instant it is sent', async () => {
    const view = mountInspector()
    view.open()

    await view.say('hello')

    // Nothing has been appended to any log yet — this bubble exists because a
    // pure reducer added it to the derived list.
    expect(turns(view)).toEqual(['user · pending · hello'])
    expect(view.exchanges.sent.map((message) => message.text)).toEqual(['hello'])
  })

  it('names the exchange, so the server writes the id the page already used', async () => {
    const view = mountInspector()

    await view.say('hello')

    expect(sentId(view)).toMatch(/\S/)
    expect(view.container.querySelector('.turn')?.getAttribute('data-message-id')).toBe(
      sentId(view),
    )
  })

  it('does not show it twice when the event arrives', async () => {
    const view = mountInspector()
    view.open()
    await view.say('hello')

    view.send(wireEvent(0, 'user/message', { id: sentId(view), text: 'hello' }))

    // The request is still open — the model is replying — so the optimistic
    // turn is still being offered. It is dropped because the log now has one
    // with the same id, not because anything cleared a flag.
    expect(turns(view)).toEqual(['user · complete · hello'])
  })

  it('does not flicker when the reply finishes', async () => {
    const view = mountInspector()
    view.open()
    await view.say('hello')
    const script = exchangeEvents(sentId(view), 'hello', ['one', ' two'])
    view.send(...script.all, script.finish())

    await view.settle()

    expect(turns(view)).toEqual(['user · complete · hello', 'assistant · complete · one two'])
  })

  it('keeps the composer shut while the model is replying', async () => {
    const view = mountInspector()
    const send = () => view.container.querySelector('.composer-send') as HTMLButtonElement

    expect(send().disabled).toBe(false)
    await view.say('hello')
    // `pending` comes from the form's own action, not from a flag this
    // component sets and has to remember to unset.
    expect(send().disabled).toBe(true)

    await view.settle()
    expect(send().disabled).toBe(false)
  })

  it('ignores an empty composer', async () => {
    const view = mountInspector()

    await view.say('   ')

    expect(view.exchanges.sent).toEqual([])
    expect(turns(view)).toEqual([])
  })

  it('reports a refusal without losing what was typed', async () => {
    const view = mountInspector()
    await view.say('hello')

    await view.fail('the harness answered 409')

    const input = view.container.querySelector('.composer-input') as HTMLTextAreaElement
    expect(view.container.querySelector('.composer-error')?.textContent).toBe(
      'the harness answered 409',
    )
    expect(input.value).toBe('hello')
    // The optimistic turn is gone with the action that offered it: the log
    // never heard about this message, so the conversation does not claim it.
    expect(turns(view)).toEqual([])
  })

  it('clears the composer once the message is on its way', async () => {
    const view = mountInspector()

    await view.say('hello')
    await view.settle()

    expect((view.container.querySelector('.composer-input') as HTMLTextAreaElement).value).toBe('')
  })
})

describe('reloading mid-conversation', () => {
  it('reproduces a half-finished reply exactly', () => {
    const half = exchangeEvents('a', 'hello', ['one', ' two']).all

    const before = mountInspector()
    before.open()
    before.send(...half)
    const rendered = conversation(before).innerHTML

    const after = mountInspector()
    after.open()
    after.send(...half)

    expect(conversation(after).innerHTML).toBe(rendered)
    expect(turns(after)).toEqual(['user · complete · hello', 'assistant · streaming · one two'])
  })

  it('reproduces the finished conversation exactly', () => {
    const script = exchangeEvents('a', 'hello', ['one', ' two', ' three'])
    const history = [...script.all, script.finish()]

    const before = mountInspector()
    before.open()
    before.send(...history)
    const rendered = conversation(before).innerHTML

    // A refresh is a new page over a new connection. The client keeps nothing;
    // the server replays the deltas, and the same fold runs again.
    const after = mountInspector()
    after.open()
    after.send(...history)

    expect(conversation(after).innerHTML).toBe(rendered)
  })
})

describe('the column itself', () => {
  it('holds no state of its own', () => {
    // Not `new URL('...', import.meta.url)`: Vite rewrites that into an asset
    // reference. Same reason as in `helpers/contrast.ts`.
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '../src/panels/conversation-panel.tsx'), 'utf8')

    // The acceptance criterion for this step, kept honest. `useOptimistic` and
    // `useActionState` are allowed — neither holds the conversation, and both
    // are cleared by React when the action they belong to ends. A `useState`
    // here would be a second copy of something the log already knows.
    expect(source).not.toMatch(/\buseState\b/)
    expect(source).not.toMatch(/\buseReducer\b/)
    expect(source).not.toMatch(/\buseEffect\b/)
  })
})
