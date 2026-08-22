/**
 * The model's view, and the invariant that keeps it honest.
 *
 * The mistake this file exists to make impossible is one line long: keep a
 * `messages` array beside the log, and update it on every path that appends.
 * It works, right up until one path forgets — and then the middle column and
 * the right column are showing two different conversations, both derived from
 * something, neither derived from the same thing. Two sources of truth is zero
 * sources of truth.
 *
 * So the assertion that matters here is not that the projection is pretty. It
 * is that what the adapter was handed equals what the log projects at that
 * instant, with no third thing in between. See ADR-0006.
 */

import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import type { SessionEvent } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter, ModelMessage, StreamChunk } from '@harness/llm'
import { recordExchange } from '../src/exchange.ts'
import { MESSAGE_RULES, deriveMessages } from '../src/messages.ts'
import { EXCHANGE_EVENT_TYPES } from '../src/types.ts'

/** Ids that read well in a failure message, instead of UUIDs. */
function counter(prefix = 'm'): () => string {
  let next = 0
  return () => `${prefix}${(next += 1)}`
}

/** What one request was made of, captured from inside the adapter. */
interface Request {
  /** Exactly the array the adapter was given. */
  readonly sent: readonly ModelMessage[]
  /** The log as it stood when the request was made. */
  readonly events: readonly SessionEvent[]
}

/**
 * An adapter that writes down every request before answering it.
 *
 * @param log - the log to snapshot at request time.
 * @param reply - what to stream back.
 * @returns the adapter and the requests it has seen.
 */
function recordingAdapter(
  log: SessionLog,
  reply = 'ok',
): { adapter: ModelAdapter; requests: Request[] } {
  const requests: Request[] = []
  return {
    requests,
    adapter: {
      name: 'recording',
      async *stream(messages): AsyncGenerator<StreamChunk> {
        requests.push({ sent: messages, events: log.events })
        yield { type: 'text-delta', text: reply }
      },
    },
  }
}

describe('deriveMessages', () => {
  it('is empty for an empty log', () => {
    expect(deriveMessages(new SessionLog())).toEqual([])
  })

  it('includes the new user message in the request it is about to make', async () => {
    const log = new SessionLog()
    const { adapter, requests } = recordingAdapter(log)

    await recordExchange({ log, adapter, text: 'what did I just say?', newId: counter() })

    expect(requests[0]?.sent).toEqual([{ role: 'user', content: 'what did I just say?' }])
  })

  it('grows with the conversation, oldest first', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'reply' })
    const newId = counter()

    await recordExchange({ log, adapter, text: 'first', newId })
    await recordExchange({ log, adapter, text: 'second', newId })

    expect(deriveMessages(log)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply' },
    ])
  })

  it('ignores chunks, so the model is not shown the reply twice', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: 'a b c d' })

    await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(deriveMessages(log)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a b c d' },
    ])
  })

  it('ignores events it does not understand rather than guessing', () => {
    const log = new SessionLog()
    log.append('demo/hello', { message: 'not part of the conversation' })
    log.append('user/message', { id: 'x', text: 'real' })
    log.append('user/message', { id: 'y' })

    expect(deriveMessages(log)).toEqual([{ role: 'user', content: 'real' }])
  })

  it('gives the same answer for the same events, every time', () => {
    // The property the browser leans on: a replica is a prefix of the log, so
    // folding it there and folding it here cannot disagree.
    const log = new SessionLog()
    log.append('user/message', { id: 'x', text: 'hi' })
    log.append('assistant/message', { id: 'x', text: 'hello', reason: 'stop', chunks: 1 })

    expect(deriveMessages(log)).toEqual(deriveMessages(log.events))
    expect(JSON.stringify(deriveMessages(log))).toBe(
      '[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]',
    )
  })

  it('hands back something nobody can edit into a second source of truth', () => {
    const log = new SessionLog()
    log.append('user/message', { id: 'x', text: 'hi' })
    const messages = deriveMessages(log)

    expect(Object.isFrozen(messages)).toBe(true)
    expect(() => (messages as ModelMessage[]).push({ role: 'user', content: 'sneaky' })).toThrow(
      /not extensible/,
    )
  })
})

describe('the rule table', () => {
  it('is the only thing that decides what the model sees', () => {
    // The acceptance criterion, machine-checked: an event type changes the
    // request exactly when the table names it. Teaching the model about a new
    // kind of fact is therefore one entry in `MESSAGE_RULES` and nothing else.
    for (const type of Object.values(EXCHANGE_EVENT_TYPES)) {
      const log = new SessionLog()
      // Deliberately generous: every payload carries `text`, so a type that
      // contributes nothing does so because it has no rule rather than because
      // there was nothing to read.
      log.append(type, { id: 'm1', index: 0, text: 'anything', reason: 'stop', chunks: 1 })

      expect(deriveMessages(log).length > 0, `${type} affects the request`).toBe(
        type in MESSAGE_RULES,
      )
    }
  })

  it('names the two types a conversation is made of', () => {
    expect(Object.keys(MESSAGE_RULES).toSorted()).toEqual(['assistant/message', 'user/message'])
  })
})

describe('the request', () => {
  it('is what the log projects, at the instant it is made', async () => {
    // The drift guard. A `messages` array kept beside the log would pass this
    // on the happy path and fail the moment a branch updated one and not the
    // other — which is precisely the bug that made this a projection.
    const log = new SessionLog()
    const { adapter, requests } = recordingAdapter(log, 'reply')
    const newId = counter()

    await recordExchange({ log, adapter, text: 'first', newId })
    await recordExchange({ log, adapter, text: 'second', newId })

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(JSON.stringify(request.sent)).toBe(JSON.stringify(deriveMessages(request.events)))
    }
  })

  it('carries the previous reply, and nothing about how it arrived', async () => {
    const log = new SessionLog()
    const { adapter, requests } = recordingAdapter(log, 'the reply')
    const newId = counter()

    await recordExchange({ log, adapter, text: 'first', newId })
    await recordExchange({ log, adapter, text: 'second', newId })

    expect(requests[1]?.sent).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'the reply' },
      { role: 'user', content: 'second' },
    ])
  })

  describe('after a stream that died halfway', () => {
    const failing: ModelAdapter = {
      name: 'failing',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', text: 'half a th' }
        await Promise.resolve()
        throw new Error('provider hung up')
      },
    }

    it('keeps what the human said and drops the reply that never finished', async () => {
      const log = new SessionLog()
      const newId = counter()

      await expect(recordExchange({ log, adapter: failing, text: 'hi', newId })).rejects.toThrow(
        'provider hung up',
      )

      // The deltas are still in the log, and the middle column still shows
      // them — an abandoned attempt is a thing that happened. But no
      // `assistant/message` was ever appended, so the log never called that
      // reply finished, and the model is not told it said half a word. The two
      // columns disagree here on purpose; ADR-0006 argues why.
      expect(log.events.some((event) => event.type === 'assistant/chunk')).toBe(true)
      expect(deriveMessages(log)).toEqual([{ role: 'user', content: 'hi' }])
    })

    it('shows the retry the same history, plus what was said again', async () => {
      const log = new SessionLog()
      const newId = counter()
      await expect(recordExchange({ log, adapter: failing, text: 'hi', newId })).rejects.toThrow(
        'provider hung up',
      )

      const { adapter, requests } = recordingAdapter(log)
      await recordExchange({ log, adapter, text: 'hi again', newId })

      expect(requests[0]?.sent).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'user', content: 'hi again' },
      ])
    })
  })
})
