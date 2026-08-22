/**
 * The deliberate mistake for step #6, kept runnable.
 *
 * Durability looks like a serialisation problem, so the first version saves
 * the thing you were about to render: the messages, the turns, whatever the
 * fold produced. It is smaller, it loads in one `JSON.parse`, and it restores
 * a session perfectly — under the code that wrote it.
 *
 * The bill arrives the first time a new event type matters. A fold is lossy by
 * construction: it keeps what the rules of the day asked for and drops the
 * rest. Replaying a log through new code re-decides that; replaying a snapshot
 * can only repeat the old decision, because the evidence is not in the file.
 */

import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import type { SessionEvent } from '@harness/session'
import type { ModelMessage } from '@harness/llm'
import { MESSAGE_RULES } from '../src/messages.ts'
import type { MessageRule } from '../src/messages.ts'

/** A session recorded before anybody had written a `tool/result` rule. */
function recordOldSession(): SessionLog {
  const log = new SessionLog({ now: () => 1_700_000_000_000 })
  log.append('user/message', { id: 'a', text: 'what is in the repo?' })
  log.append('tool/call', { id: 'a', name: 'list', args: { path: '.' } })
  log.append('tool/result', { id: 'a', name: 'list', text: 'README.md src/' })
  log.append('assistant/message', { id: 'a', text: 'a README and a src directory', chunks: 4 })
  return log
}

/** The fold of the day, under whichever rules are in force. */
function fold(
  events: readonly SessionEvent[],
  rules: Readonly<Record<string, MessageRule>>,
): readonly ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const event of events) {
    const message = rules[event.type]?.(event)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

/**
 * How you write it the first time: persist what you were going to send.
 *
 * The `version` is the tell. A file that holds derived state has to carry the
 * version of the code that derived it, because the shape is only meaningful
 * next to the rules that produced it.
 */
function saveSnapshot(events: readonly SessionEvent[]): string {
  return JSON.stringify({ version: 1, messages: fold(events, MESSAGE_RULES) })
}

function loadSnapshot(saved: string): readonly ModelMessage[] {
  const parsed = JSON.parse(saved) as { version: number; messages: ModelMessage[] }
  if (parsed.version !== 1) throw new Error(`no migration from snapshot version ${parsed.version}`)
  return parsed.messages
}

/** What the log costs instead: every event, verbatim, one per line. */
function saveLog(events: readonly SessionEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('')
}

function loadLog(saved: string): readonly SessionEvent[] {
  return saved
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent)
}

/** The next version of the table: tool results are now shown to the model. */
const RULES_WITH_TOOLS: Readonly<Record<string, MessageRule>> = Object.freeze({
  ...MESSAGE_RULES,
  'tool/result': (event) => {
    const text = event.data['text']
    return typeof text === 'string'
      ? { role: 'user', content: `[${String(event.data['name'])}] ${text}` }
      : undefined
  },
})

describe('persisting the fold instead of the log', () => {
  it('restores the session perfectly under the code that wrote it', () => {
    const events = recordOldSession().events

    const fromSnapshot = loadSnapshot(saveSnapshot(events))
    const fromLog = fold(loadLog(saveLog(events)), MESSAGE_RULES)

    // Both round-trip. This is the whole appeal of the wrong one, and the
    // reason it survives review: nothing on screen is different.
    expect(fromSnapshot).toEqual(fromLog)
    expect(fromSnapshot.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('cannot show an old session to new code, because the evidence was dropped', () => {
    const saved = {
      snapshot: saveSnapshot(recordOldSession().events),
      log: saveLog(recordOldSession().events),
    }

    // New code, old file. The log re-decides what the model is shown; the
    // snapshot can only repeat what the old rules decided.
    const fromLog = fold(loadLog(saved.log), RULES_WITH_TOOLS)
    const fromSnapshot = loadSnapshot(saved.snapshot)

    expect(fromLog.map((message) => message.content)).toEqual([
      'what is in the repo?',
      '[list] README.md src/',
      'a README and a src directory',
    ])
    // No migration recovers this. The tool result is not "in an old format" in
    // the snapshot file — it is absent, and was absent before the process that
    // wrote it exited.
    expect(fromSnapshot).toHaveLength(2)
    expect(JSON.stringify(saved.snapshot)).not.toContain('README.md src/')
    expect(saved.log).toContain('README.md src/')
  })

  it('makes every future reader carry a migration for every past writer', () => {
    const events = recordOldSession().events
    const snapshotV2 = JSON.stringify({ version: 2, messages: fold(events, RULES_WITH_TOOLS) })

    // A reader that has moved on refuses the old file, or grows a branch per
    // version it has ever written. The log has neither: an event is a fact,
    // and a fact does not have a schema version to negotiate.
    expect(() => loadSnapshot(snapshotV2)).toThrow(/no migration/)
    expect(loadLog(saveLog(events))).toHaveLength(events.length)
  })

  it('loses the facts no rule has ever read, which is most of them', () => {
    const log = recordOldSession()
    log.append('assistant/usage', { id: 'a', input: 12, output: 34 })

    const fromLog = loadLog(saveLog(log.events))

    // `assistant/usage` contributes nothing to the request and so nothing to
    // the snapshot — yet the token metering in #21 is built entirely out of
    // it. Persisting the fold decides, at write time, which questions the
    // future is allowed to ask.
    expect(loadSnapshot(saveSnapshot(log.events))).toHaveLength(2)
    expect(fromLog.filter((event) => event.type === 'assistant/usage')).toHaveLength(1)
    expect(fromLog.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4])
  })
})
