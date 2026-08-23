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
import type { Turn } from '../src/conversation.ts'

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
  return deriveConversation(events).map((turn) => `${turn.role} · ${turn.state} · ${textOf(turn)}`)
}

/** What a turn says, whichever kind it is. */
function textOf(turn: Turn | undefined): string {
  if (turn === undefined) return ''
  return turn.role === 'tool' ? turn.result : turn.text
}

/** Why a turn failed, when it is the kind of turn that can say. */
function errorOf(turn: Turn | undefined): string | undefined {
  return turn === undefined || turn.role === 'tool' ? undefined : turn.error
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

    expect(turns.map((turn) => `${turn.state} · ${textOf(turn)}`)).toEqual([
      'complete · hi',
      'failed · half a sen',
    ])
    expect(errorOf(turns[1])).toBe('provider hung up')
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
    // so the key has to be more than the id. And an exchange can now hold more
    // than one reply, so the key has to be more than the role too.
    expect(turns.map((turn) => turn.id)).toEqual(['a', 'a'])
    expect(turns.map((turn) => turn.key)).toEqual(['user:a', 'assistant:a:0'])
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

    expect(withOptimistic(other, optimisticTurn('a', 'mine')).map(textOf)).toEqual([
      'something else',
      'mine',
    ])
  })

  it('changes nothing when there is nothing in flight', () => {
    const turns = deriveConversation([exchange('a').said(0, 'hi')])

    expect(withOptimistic(turns, undefined)).toBe(turns)
  })
})

/** One step's worth of tool events, as `recordExchange` writes them. */
function call(id: string, step: number, callId: string) {
  return {
    asked: (seq: number, name: string, args: string) =>
      event(seq, 'tool/call', { id, step, callId, name, arguments: args }),
    answered: (seq: number, name: string, content: string, isError = false) =>
      event(seq, 'tool/result', { id, step, callId, name, content, isError }),
    replied: (seq: number, text: string) =>
      event(seq, 'assistant/message', { id, step, text, reason: 'stop', chunks: 1 }),
    calling: (seq: number, calls: unknown) =>
      event(seq, 'assistant/message', {
        id,
        step,
        text: '',
        reason: 'tool_calls',
        chunks: 0,
        toolCalls: calls as never,
      }),
  }
}

describe('tool cards', () => {
  it('opens a card the moment a call is logged, with no result yet', () => {
    const c = call('a', 0, 'call_1')
    const turns = deriveConversation([
      exchange('a').said(0, 'what is in src?'),
      c.asked(1, 'list_directory', '{"path":"src"}'),
    ])
    const card = turns[1]

    expect(card?.role).toBe('tool')
    expect(card?.state).toBe('pending')
    expect(card?.role === 'tool' && card.name).toBe('list_directory')
    expect(card?.role === 'tool' && card.arguments).toBe('{"path":"src"}')
    expect(card?.role === 'tool' && card.result).toBe('')
  })

  it('finishes the same card when the result lands — it does not open a second', () => {
    // Pending is the absence of a fact, not a flag: nothing sets it, and
    // nothing clears it. Appending the result is the whole transition.
    const c = call('a', 0, 'call_1')
    const before = [exchange('a').said(0, 'what is in src?'), c.asked(1, 'list_directory', '{}')]
    const after = [...before, c.answered(2, 'list_directory', 'index.ts\nmain.ts')]

    expect(deriveConversation(before)).toHaveLength(2)
    const turns = deriveConversation(after)

    expect(turns).toHaveLength(2)
    expect(turns[1]?.key).toBe(deriveConversation(before)[1]?.key)
    expect(turns[1]?.state).toBe('complete')
    expect(textOf(turns[1])).toBe('index.ts\nmain.ts')
  })

  it('shows a failing tool as a finished card, not a broken turn', () => {
    const c = call('a', 0, 'call_1')
    const turns = deriveConversation([
      exchange('a').said(0, 'read nope.md'),
      c.asked(1, 'read_file', '{"path":"nope.md"}'),
      c.answered(2, 'read_file', '"nope.md" does not exist', true),
    ])
    const card = turns[1]

    expect(card?.state).toBe('failed')
    expect(card?.role === 'tool' && card.isError).toBe(true)
    expect(textOf(card)).toBe('"nope.md" does not exist')
  })

  it('keeps two calls of one step apart, in the order they were logged', () => {
    const first = call('a', 0, 'call_1')
    const second = call('a', 0, 'call_2')
    const turns = deriveConversation([
      exchange('a').said(0, 'read both'),
      first.asked(1, 'read_file', '{"path":"a.md"}'),
      second.asked(2, 'read_file', '{"path":"b.md"}'),
      second.answered(3, 'read_file', 'bee'),
      first.answered(4, 'read_file', 'ay'),
    ])

    expect(turns.map((turn) => `${turn.state} · ${textOf(turn)}`)).toEqual([
      'complete · read both',
      'complete · ay',
      'complete · bee',
    ])
  })

  it('puts the card between the two things the model said', () => {
    const c = call('a', 0, 'call_1')
    const answer = call('a', 1, 'unused')
    const turns = deriveConversation([
      exchange('a').said(0, 'what is in src?'),
      c.replied(1, 'Let me look.'),
      c.asked(2, 'list_directory', '{"path":"src"}'),
      c.answered(3, 'list_directory', 'index.ts'),
      answer.replied(4, 'One file: index.ts.'),
    ])

    expect(turns.map((turn) => `${turn.role} · ${textOf(turn)}`)).toEqual([
      'user · what is in src?',
      'assistant · Let me look.',
      'tool · index.ts',
      'assistant · One file: index.ts.',
    ])
  })

  it('keeps the two replies of one exchange apart', () => {
    // Before steps, both replies shared the key `assistant:a` and the second
    // silently overwrote the first. The step is what separates them.
    const c = call('a', 0, 'call_1')
    const turns = deriveConversation([
      exchange('a').said(0, 'hi'),
      c.replied(1, 'Let me look.'),
      c.asked(2, 'list_directory', '{}'),
      c.answered(3, 'list_directory', 'index.ts'),
      call('a', 1, 'unused').replied(4, 'One file.'),
    ])

    expect(turns.map((turn) => turn.key)).toEqual([
      'user:a',
      'assistant:a:0',
      'tool:a:call_1',
      'assistant:a:1',
    ])
  })

  it('does not draw an empty bubble for a reply that was only tool calls', () => {
    const c = call('a', 0, 'call_1')
    const turns = deriveConversation([
      exchange('a').said(0, 'what is in src?'),
      c.calling(1, [{ id: 'call_1', name: 'list_directory', arguments: '{}' }]),
      c.asked(2, 'list_directory', '{}'),
      c.answered(3, 'list_directory', 'index.ts'),
    ])

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'tool'])
  })

  it('ignores a result whose call it never saw', () => {
    // Impossible if the loop is working; harmless if a log is truncated.
    const turns = deriveConversation([
      exchange('a').said(0, 'hi'),
      call('a', 0, 'call_1').answered(1, 'read_file', 'contents'),
    ])

    expect(turns.map((turn) => turn.role)).toEqual(['user'])
  })

  it('shows where a run that hit the step limit was cut off', () => {
    const c = call('a', 0, 'call_1')
    const turns = deriveConversation([
      exchange('a').said(0, 'keep going'),
      c.asked(1, 'list_directory', '{}'),
      c.answered(2, 'list_directory', 'index.ts'),
      event(3, 'error/steps', { id: 'a', step: 1, limit: 1, message: 'stopped after 1 step' }),
    ])

    expect(turns.map((turn) => `${turn.role} · ${turn.state}`)).toEqual([
      'user · complete',
      'tool · complete',
      'assistant · failed',
    ])
    expect(errorOf(turns[2])).toBe('stopped after 1 step')
  })
})
