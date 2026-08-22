/**
 * The deliberate mistake for step #3, kept runnable.
 *
 * The wrong version is three lines shorter and renders identically. What it
 * costs is invisible until the page reloads, which is exactly why the mistake
 * is worth making once on purpose rather than shipping it by accident.
 */

import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter } from '@harness/llm'
import { recordExchange, replayChunks } from '../src/exchange.ts'

const REPLY = 'every word of this arrived separately'

/**
 * How you write it the first time: accumulate in a local, append at the end.
 *
 * The local `text` is the bug. It exists only inside this call, so the moment
 * the function returns, the only trace that anything was streamed is a message
 * that looks exactly like a message that was not.
 */
async function recordFinalMessageOnly(log: SessionLog, adapter: ModelAdapter, text: string) {
  log.append('user/message', { id: 'wrong', text })
  let assembled = ''
  for await (const chunk of adapter.stream([{ role: 'user', content: text }])) {
    if (chunk.type === 'text-delta') assembled += chunk.text
  }
  log.append('assistant/message', { id: 'wrong', text: assembled })
}

/** What a reload gives you: the events, over the wire, and nothing else. */
function afterReload(log: SessionLog) {
  return JSON.parse(JSON.stringify(log.events)) as { type: string; data: { text?: string } }[]
}

describe('accumulating the reply in a local variable', () => {
  it('renders the same reply as recording every delta', async () => {
    const adapter = createScriptedAdapter({ reply: REPLY })
    const wrong = new SessionLog()
    const right = new SessionLog()

    await recordFinalMessageOnly(wrong, adapter, 'hi')
    await recordExchange({ log: right, adapter, text: 'hi', newId: () => 'right' })

    const finalText = (log: SessionLog) =>
      log.events.find((event) => event.type === 'assistant/message')?.data.text
    expect(finalText(wrong)).toBe(REPLY)
    expect(finalText(right)).toBe(REPLY)
  })

  it('leaves nothing behind to reconstruct the stream from', async () => {
    const log = new SessionLog()

    await recordFinalMessageOnly(log, createScriptedAdapter({ reply: REPLY }), 'hi')

    // Six deltas were received. The log records that a reply exists and says
    // nothing whatsoever about how it got here.
    expect(afterReload(log).filter((event) => event.type === 'assistant/chunk')).toEqual([])
    expect(replayChunks(log.events, 'wrong')).toBe('')
  })

  it('cannot tell a streamed reply from one that arrived in a single piece', async () => {
    const streamed = new SessionLog()
    const atOnce = new SessionLog()

    await recordFinalMessageOnly(streamed, createScriptedAdapter({ reply: REPLY }), 'hi')
    await recordFinalMessageOnly(
      atOnce,
      {
        name: 'one-shot',
        stream: async function* () {
          yield { type: 'text-delta', text: REPLY }
        },
      },
      'hi',
    )

    // Two different streams, one indistinguishable record. Any question about
    // streaming behaviour — did it stall, did it arrive in order, what had the
    // user seen when it failed — is now unanswerable offline.
    expect(afterReload(streamed).map((event) => event.data)).toEqual(
      afterReload(atOnce).map((event) => event.data),
    )
  })

  it('is fixed by recording each delta, which is what recordExchange does', async () => {
    const log = new SessionLog()

    const result = await recordExchange({
      log,
      adapter: createScriptedAdapter({ reply: REPLY }),
      text: 'hi',
      newId: () => 'right',
    })

    const reloaded = afterReload(log)
    expect(reloaded.filter((event) => event.type === 'assistant/chunk')).toHaveLength(6)
    expect(replayChunks(log.events, result.id)).toBe(REPLY)
  })
})
