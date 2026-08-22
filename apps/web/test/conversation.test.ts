/**
 * The fold, on its own.
 *
 * No DOM here on purpose: the conversation is a pure function of the event
 * array, so everything about grouping, concatenation and completeness can be
 * asserted without rendering anything. If a test in this file needs a
 * component, the projection has leaked into the view.
 */

import { describe, expect, it } from 'vitest'
import type { JsonObject, SessionEvent } from '@harness/session'
import { deriveConversation, optimisticTurn, withOptimistic } from '../src/conversation.ts'

function event(seq: number, type: string, data: JsonObject): SessionEvent {
  return { seq, type, time: 1_700_000_000_000 + seq, data }
}

/** One exchange's events, as `recordExchange` writes them. */
function exchange(id: string) {
  return {
    said: (seq: number, text: string) => event(seq, 'user/message', { id, text }),
    delta: (seq: number, index: number, text: string) =>
      event(seq, 'assistant/chunk', { id, index, text }),
    usage: (seq: number) => event(seq, 'assistant/usage', { id, input: 2, output: 4 }),
    replied: (seq: number, text: string) =>
      event(seq, 'assistant/message', { id, text, reason: 'stop', chunks: 2 }),
    broke: (seq: number, message: string) => event(seq, 'error/stream', { id, message, chunks: 1 }),
  }
}

/** Each turn as `role · state · text`, which is all a reader cares about. */
function shape(events: readonly SessionEvent[]): string[] {
  return deriveConversation(events).map((turn) => `${turn.role} · ${turn.state} · ${turn.text}`)
}

describe('deriving the conversation', () => {
  it('has nothing to show for an empty log', () => {
    expect(deriveConversation([])).toEqual([])
  })

  it('makes a finished turn out of what the human said', () => {
    const one = exchange('a')

    expect(shape([one.said(0, 'hello')])).toEqual(['user · complete · hello'])
  })

  it('concatenates the deltas of a reply into one bubble', () => {
    const one = exchange('a')

    expect(
      shape([
        one.said(0, 'hi'),
        one.delta(1, 0, 'one'),
        one.delta(2, 1, ' two'),
        one.delta(3, 2, ' three'),
      ]),
    ).toEqual(['user · complete · hi', 'assistant · streaming · one two three'])
  })

  it('grows the same bubble as each delta lands', () => {
    const one = exchange('a')
    const so_far = [one.said(0, 'hi'), one.delta(1, 0, 'on')]

    // The typewriter, spelled out: the array grew by one fact and the same
    // pure function produced one more character. Nobody appended anything.
    expect(shape(so_far)).toEqual(['user · complete · hi', 'assistant · streaming · on'])
    expect(shape([...so_far, one.delta(2, 1, 'e')])).toEqual([
      'user · complete · hi',
      'assistant · streaming · one',
    ])
  })

  it('is finished only once the assembled message arrives', () => {
    const one = exchange('a')
    const streaming = [one.said(0, 'hi'), one.delta(1, 0, 'one'), one.delta(2, 1, ' two')]

    expect(shape(streaming)).toEqual(['user · complete · hi', 'assistant · streaming · one two'])
    expect(shape([...streaming, one.usage(3), one.replied(4, 'one two')])).toEqual([
      'user · complete · hi',
      'assistant · complete · one two',
    ])
  })

  it('prefers the assembled message over its own concatenation', () => {
    const one = exchange('a')

    // They agree byte for byte in a healthy log. When they cannot, the log's
    // own summary is the one to believe.
    expect(
      shape([one.said(0, 'hi'), one.delta(1, 0, 'partial'), one.replied(2, 'the whole thing')]),
    ).toEqual(['user · complete · hi', 'assistant · complete · the whole thing'])
  })

  it('says nothing about what a reply cost', () => {
    const one = exchange('a')

    // Usage is a fact about the request. The middle column is what the human
    // sees, and the human did not pay in tokens.
    expect(shape([one.said(0, 'hi'), one.usage(1), one.replied(2, 'hello')])).toEqual([
      'user · complete · hi',
      'assistant · complete · hello',
    ])
  })

  it('keeps the deltas of a reply that broke, and says it broke', () => {
    const one = exchange('a')
    const turns = deriveConversation([
      one.said(0, 'hi'),
      one.delta(1, 0, 'half a sen'),
      one.broke(2, 'provider hung up'),
    ])

    expect(turns.map((turn) => `${turn.state} · ${turn.text}`)).toEqual([
      'complete · hi',
      'failed · half a sen',
    ])
    expect(turns[1]?.error).toBe('provider hung up')
  })

  it('keeps two replies apart when their deltas interleave', () => {
    const one = exchange('a')
    const two = exchange('b')

    // `seq` orders the log; the id says which reply a delta belongs to. This
    // is the case the id exists for.
    expect(
      shape([
        one.said(0, 'first'),
        two.said(1, 'second'),
        one.delta(2, 0, 'a'),
        two.delta(3, 0, 'x'),
        one.delta(4, 1, 'b'),
        two.delta(5, 1, 'y'),
      ]),
    ).toEqual([
      'user · complete · first',
      'user · complete · second',
      'assistant · streaming · ab',
      'assistant · streaming · xy',
    ])
  })

  it('tells the two halves of one exchange apart', () => {
    const one = exchange('a')
    const turns = deriveConversation([one.said(0, 'hi'), one.replied(1, 'hello')])

    // Both carry the same message id — an id names an exchange, not a bubble —
    // so the key has to be more than the id.
    expect(turns.map((turn) => turn.id)).toEqual(['a', 'a'])
    expect(turns.map((turn) => turn.key)).toEqual(['user:a', 'assistant:a'])
  })

  it('ignores events that belong to another column', () => {
    const one = exchange('a')

    expect(shape([event(0, 'demo/hello', { message: 'hi' }), one.said(1, 'hello')])).toEqual([
      'user · complete · hello',
    ])
  })

  it('skips an event whose payload is not one it can read', () => {
    // A malformed frame is the feed client's problem. A well-formed event with
    // a payload this projection does not understand is simply not a turn.
    expect(
      shape([
        event(0, 'user/message', { text: 'no id' }),
        event(1, 'user/message', { id: 'a', text: 42 }),
        event(2, 'user/message', { id: 'b', text: 'fine' }),
      ]),
    ).toEqual(['user · complete · fine'])
  })

  it('produces the same conversation from the same events, every time', () => {
    // The reload criterion, as a property: replaying the log calls this with
    // the same input, and a pure function of the same input is the same
    // output. There is nothing else to restore.
    const one = exchange('a')
    const history = [
      one.said(0, 'hi'),
      one.delta(1, 0, 'he'),
      one.delta(2, 1, 'llo'),
      one.replied(3, 'hello'),
    ]

    expect(deriveConversation(history)).toEqual(deriveConversation([...history]))
  })

  it('hands out turns nobody can edit', () => {
    const one = exchange('a')
    const [turn] = deriveConversation([one.said(0, 'hi')])

    expect(Object.isFrozen(turn)).toBe(true)
  })
})

describe('the turn the log has not confirmed yet', () => {
  it('is added while it is missing', () => {
    const pending = optimisticTurn('a', 'hello')

    expect(withOptimistic([], pending)).toEqual([pending])
    expect(pending.state).toBe('pending')
  })

  it('is dropped the moment the log has one with the same id', () => {
    const confirmed = deriveConversation([exchange('a').said(0, 'hello')])

    // Not compared by text, not timed out: the client named the exchange, so
    // this is an identity check.
    expect(withOptimistic(confirmed, optimisticTurn('a', 'hello'))).toBe(confirmed)
  })

  it('still shows when a different exchange lands first', () => {
    const other = deriveConversation([exchange('b').said(0, 'something else')])

    expect(withOptimistic(other, optimisticTurn('a', 'mine')).map((turn) => turn.text)).toEqual([
      'something else',
      'mine',
    ])
  })

  it('changes nothing when there is nothing in flight', () => {
    const turns = deriveConversation([exchange('a').said(0, 'hi')])

    expect(withOptimistic(turns, undefined)).toBe(turns)
  })
})
