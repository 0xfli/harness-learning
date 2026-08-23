/**
 * The summary rules, on their own.
 *
 * Every test here is one restatement of the same claim: a row shows what is
 * *different* about its event. The bug that motivated the module is asserted
 * directly — twelve rows of one exchange used to be twelve copies of the same
 * message id, because the id is the first field of every payload and the
 * column clips.
 */

import { describe, expect, it } from 'vitest'
import type { JsonObject, SessionEvent } from '@harness/session'
import { messageIdOf, payloadOf, summariseEvent } from '../src/event-summary.ts'

const ID = '1b4f978e-1c38-4e85-9f5b-b5518a8abc60'

function event(type: string, data: JsonObject): SessionEvent {
  return { seq: 0, type, time: 1_700_000_000_000, data }
}

/** One event of the exchange every payload in this file belongs to. */
function of(type: string, data: JsonObject): SessionEvent {
  return event(type, { id: ID, ...data })
}

describe('the deliberate bug this module fixes', () => {
  it('no longer opens every row with the same thirty-six characters', () => {
    // What the column used to render: `JSON.stringify(data)`, clipped. Every
    // row of an exchange began identically, so the visible part was the one
    // field that cannot tell two rows apart.
    const log = [
      of('assistant/chunk', { step: 0, index: 0, text: 'Hel' }),
      of('assistant/chunk', { step: 0, index: 1, text: 'lo' }),
      of('assistant/usage', { step: 0, input: 3, output: 2 }),
    ]

    expect(log.map((e) => JSON.stringify(e.data).slice(0, 20))).toEqual([
      '{"id":"1b4f978e-1c38',
      '{"id":"1b4f978e-1c38',
      '{"id":"1b4f978e-1c38',
    ])
    expect(log.map(summariseEvent)).toEqual(['"Hel"', '"lo"', '3 in · 2 out'])
  })

  it('never begins a summary with the message id', () => {
    const log = [
      of('user/message', { text: 'hi' }),
      of('assistant/chunk', { step: 0, index: 0, text: 'x' }),
      of('assistant/reasoning', { step: 0, index: 0, text: 'y' }),
      of('assistant/usage', { step: 0, input: 1, output: 1 }),
      of('assistant/message', { step: 0, text: 'hello', reason: 'stop', chunks: 1 }),
      of('tool/call', { step: 0, callId: 'c1', name: 'read_file', arguments: '{}' }),
      of('tool/result', { step: 0, callId: 'c1', name: 'read_file', content: 'x', isError: false }),
      of('error/stream', { step: 0, message: 'hung up', chunks: 1 }),
      of('error/steps', { step: 8, limit: 8, message: 'stopped' }),
      of('future/thing', { shape: 'unknown' }),
    ]

    expect(log.map(summariseEvent).filter((line) => line.includes(ID))).toEqual([])
  })

  it('keeps the id where something can group by it', () => {
    // Dropped from the line, not from the row: it is a filtering key, not
    // something to read twenty times down a column.
    expect(messageIdOf(of('assistant/chunk', { text: 'x' }))).toBe(ID)
    expect(messageIdOf(event('demo/hello', { message: 'hi' }))).toBeUndefined()
  })
})

describe('a summary', () => {
  it('is what the human said', () => {
    expect(summariseEvent(of('user/message', { text: 'what is in src?' }))).toBe('what is in src?')
  })

  it('quotes a delta, because the space at the front of one is the point', () => {
    // ` there` and `there` are different deltas and would otherwise be one
    // indistinguishable row above another.
    expect(summariseEvent(of('assistant/chunk', { index: 1, text: ' there' }))).toBe('" there"')
    expect(summariseEvent(of('assistant/reasoning', { index: 0, text: 'hm ' }))).toBe('"hm "')
  })

  it('counts what a step cost', () => {
    expect(summariseEvent(of('assistant/usage', { input: 13, output: 30 }))).toBe('13 in · 30 out')
  })

  it('leads a reply with why it stopped', () => {
    expect(
      summariseEvent(of('assistant/message', { text: 'hello', reason: 'stop', chunks: 1 })),
    ).toBe('stop · hello')
  })

  it('shows the calls when a reply was only calls', () => {
    expect(
      summariseEvent(
        of('assistant/message', {
          text: '',
          reason: 'tool_calls',
          chunks: 0,
          toolCalls: [{ id: 'c1', name: 'list_directory', arguments: '{"path":"src"}' }],
        }),
      ),
    ).toBe('tool_calls · list_directory({"path":"src"})')
  })

  it('reads a call as a call', () => {
    expect(
      summariseEvent(
        of('tool/call', {
          step: 0,
          callId: 'c1',
          name: 'list_directory',
          arguments: '{"path":"src"}',
        }),
      ),
    ).toBe('list_directory({"path":"src"})')
  })

  it('points a result back at the tool that produced it', () => {
    // The arrow is the shape of the pair: a reader scanning for an unanswered
    // call is looking for a `tool/call` with no arrow under it.
    expect(
      summariseEvent(
        of('tool/result', { callId: 'c1', name: 'list_directory', content: 'a', isError: false }),
      ),
    ).toBe('list_directory → a')
  })

  it('marks a failure without hiding what it said', () => {
    expect(
      summariseEvent(
        of('tool/result', {
          callId: 'c1',
          name: 'read_file',
          content: '"nope.md" does not exist',
          isError: true,
        }),
      ),
    ).toBe('read_file → ✗ "nope.md" does not exist')
  })

  it('is the message an error carries', () => {
    expect(summariseEvent(of('error/stream', { message: 'provider hung up', chunks: 3 }))).toBe(
      'provider hung up',
    )
    expect(summariseEvent(of('error/steps', { step: 8, limit: 8, message: 'stopped' }))).toBe(
      'stopped',
    )
  })
})

describe('a type with no rule', () => {
  it('still says something, so a new event type is legible the day it exists', () => {
    expect(summariseEvent(of('future/thing', { shape: 'unknown', n: 3 }))).toBe(
      '{"shape":"unknown","n":3}',
    )
  })

  it('says nothing rather than `{}` when there is nothing to say', () => {
    expect(summariseEvent(event('demo/bye', {}))).toBe('')
    expect(summariseEvent(of('future/thing', {}))).toBe('')
  })
})

describe('a rule that does not fit the event it is given', () => {
  it('defers to the payload rather than to a blank line', () => {
    // A rule knows the fields its type usually carries. An event of that type
    // carrying different ones would otherwise render as nothing at all — the
    // payload silently unreachable, which is the bug this module exists to
    // fix, arriving from inside the fix.
    expect(summariseEvent(event('demo/hello', { from: 'curl' }))).toBe('{"from":"curl"}')
    expect(summariseEvent(of('user/message', { typo: 'text' }))).toBe('{"typo":"text"}')
  })

  it('prefers the rule whenever the rule has anything to say', () => {
    expect(summariseEvent(event('demo/hello', { message: 'hi', extra: 1 }))).toBe('hi')
  })
})

describe('a summary that would not fit on a line', () => {
  it('stays on one line, whatever the payload had in it', () => {
    // A row is `white-space: nowrap`, so a newline inside one would end the
    // visible line early and silently hide the rest — the same bug arriving by
    // another route.
    const line = summariseEvent(
      of('tool/result', {
        callId: 'c1',
        name: 'list_directory',
        content: 'exchange/\nllm/\nsession/\ntools/',
        isError: false,
      }),
    )

    expect(line).not.toContain('\n')
    expect(line).toBe('list_directory → exchange/ ⏎ llm/ ⏎ session/ ⏎ tools/')
  })
})

describe('the payload behind the summary', () => {
  it('keeps everything the summary edited out', () => {
    const one = of('tool/call', { step: 0, callId: 'c1', name: 'read_file', arguments: '{}' })

    // The summary is an edit; this is the record. Both, one click apart, so
    // neither has to compromise for the other.
    expect(JSON.parse(payloadOf(one))).toEqual(one.data)
    expect(payloadOf(one)).toContain(ID)
  })

  it('is nothing at all for an empty payload', () => {
    expect(payloadOf(event('demo/bye', {}))).toBe('')
  })
})
