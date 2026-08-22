/**
 * The deliberate mistake for step #5, kept runnable.
 *
 * The wrong version is the one everybody writes first: a `messages` array
 * beside the log, appended to on every path that appends an event. It is
 * faster, it needs no fold, and on the happy path it is correct — which is
 * what makes it dangerous. It goes wrong on the paths nobody was thinking
 * about while writing it, and when it does, nothing throws. The model is
 * simply shown a conversation that did not happen, and every screen still
 * looks right.
 *
 * Three of those paths already exist in this codebase, before there is a
 * single tool. They are below.
 */

import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter, ModelMessage, StreamChunk } from '@harness/llm'
import { recordExchange } from '../src/exchange.ts'
import { deriveMessages } from '../src/messages.ts'

const REPLY = 'a perfectly ordinary reply'

/**
 * How you write it the first time: keep the history, and remember to update
 * it.
 *
 * Every line that pushes to `#messages` is a promise to keep a second record
 * in step with the log for the rest of the program's life. Nothing enforces
 * it, and the compiler cannot: the two are related by intention only.
 */
class MaintainedHistory {
  readonly log = new SessionLog()
  readonly #messages: ModelMessage[] = []

  /** What the model would be sent. Read off the array, not the log. */
  get messages(): readonly ModelMessage[] {
    return this.#messages
  }

  async say(adapter: ModelAdapter, text: string, id = 'm1'): Promise<void> {
    this.log.append('user/message', { id, text })
    this.#messages.push({ role: 'user', content: text })

    let assembled = ''
    for await (const chunk of adapter.stream(this.#messages)) {
      if (chunk.type !== 'text-delta') continue
      this.log.append('assistant/chunk', { id, index: 0, text: chunk.text })
      assembled += chunk.text
    }

    this.log.append('assistant/message', { id, text: assembled, reason: 'stop', chunks: 1 })
    this.#messages.push({ role: 'assistant', content: assembled })
  }
}

/** What survives a restart: the log, and nothing else. */
function afterRestart(log: SessionLog): SessionLog {
  const restored = new SessionLog()
  for (const event of JSON.parse(JSON.stringify(log.events)) as SessionLog['events']) {
    restored.append(event.type, event.data)
  }
  return restored
}

describe('a messages array kept beside the log', () => {
  it('agrees with the log on the happy path, which is why it survives review', async () => {
    const harness = new MaintainedHistory()

    await harness.say(createScriptedAdapter({ reply: REPLY }), 'hello')

    expect(harness.messages).toEqual(deriveMessages(harness.log))
  })

  it('misses a fact that entered the log by another door', async () => {
    const harness = new MaintainedHistory()
    await harness.say(createScriptedAdapter({ reply: REPLY }), 'hello')

    // `POST /events` is that door, and it exists today. So is a resumed
    // session, a replayed log, and — the case the issue names — the branch
    // that records a tool result. The array is updated by exactly the code
    // paths whose author remembered it.
    harness.log.append('user/message', { id: 'm2', text: 'and another thing' })

    expect(deriveMessages(harness.log).at(-1)).toEqual({
      role: 'user',
      content: 'and another thing',
    })
    // The inspector's middle column shows that message. The model is never
    // told about it, and nothing anywhere reports a problem.
    expect(harness.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY })
    expect(harness.messages).not.toEqual(deriveMessages(harness.log))
  })

  it('claims a reply the log never called finished', async () => {
    const harness = new MaintainedHistory()
    const dies: ModelAdapter = {
      name: 'dies',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', text: 'half a th' }
        await Promise.resolve()
        throw new Error('provider hung up')
      },
    }

    await expect(harness.say(dies, 'hello')).rejects.toThrow('provider hung up')

    // The array was never given the reply, so here the drift runs the other
    // way: the log holds a delta the model will not be shown. Either
    // direction, the two records disagree and only one of them is auditable.
    expect(harness.log.events.some((event) => event.type === 'assistant/chunk')).toBe(true)
    expect(harness.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(deriveMessages(harness.log)).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('does not survive a restart, and cannot be rebuilt without a fold anyway', async () => {
    const harness = new MaintainedHistory()
    await harness.say(createScriptedAdapter({ reply: REPLY }), 'hello')

    const restored = afterRestart(harness.log)

    // The array is gone with the process. Getting it back means folding the
    // log — which is the projection, written under duress and probably not
    // the same one.
    expect(deriveMessages(restored)).toEqual(deriveMessages(harness.log))
    expect(deriveMessages(restored)).toHaveLength(2)
  })
})

describe('deriving the messages instead', () => {
  it('picks up a fact whatever door it came in through', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: REPLY })

    await recordExchange({ log, adapter, text: 'hello', newId: () => 'm1' })
    log.append('user/message', { id: 'm2', text: 'and another thing' })

    expect(deriveMessages(log)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: REPLY },
      { role: 'user', content: 'and another thing' },
    ])
  })

  it('cannot drift, because there is nothing to drift from', async () => {
    const log = new SessionLog()
    const adapter = createScriptedAdapter({ reply: REPLY })
    await recordExchange({ log, adapter, text: 'hello', newId: () => 'm1' })

    // The strongest form of the claim: the request is a function of the log,
    // so "are they in step?" is not a question that can be asked. There is one
    // record, and one reading of it.
    expect(deriveMessages(log)).toEqual(deriveMessages(afterRestart(log)))
  })
})
