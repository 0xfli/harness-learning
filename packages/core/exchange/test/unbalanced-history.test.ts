/**
 * The deliberate mistake of this step, kept.
 *
 * Written the wrong way first, on purpose: `execute` threw on a file that was
 * not there, and two things broke rather than one. The turn died, which is the
 * visible half — and the log was left holding a `tool/call` that nothing ever
 * answered, which is the half that matters. A log is not a transcript that can
 * be a bit wrong; it is the thing every later request is folded out of. So the
 * damage was not that one message failed. It was that *every* message after it
 * failed too, with a 400 from the provider blaming a request nobody could see
 * anything wrong with.
 *
 * Both halves are asserted here — the first as the history that fold produces,
 * the second as the refusal that history earns — and then the same scenario is
 * run through the real loop to show it cannot happen any more.
 *
 * The provider is stood in for rather than called. Its rule is published, and
 * a test that needs a network and a key to state an invariant is a test nobody
 * runs.
 */

import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { createOpenAiAdapter, createScriptedAdapter } from '@harness/llm'
import type { ModelMessage } from '@harness/llm'
import { createToolRegistry } from '@harness/tools'
import type { Tool } from '@harness/tools'
import { recordExchange } from '../src/exchange.ts'
import { deriveMessages } from '../src/messages.ts'

/** A `read_file` that throws on a missing path — the mistake, in one tool. */
const throwsOnMissing: Tool = {
  name: 'read_file',
  description: 'Read a file. Throws when it is not there, which is the bug.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute(args) {
    throw new Error(`ENOENT: no such file or directory, open '${String(args['path'])}'`)
  },
}

/** The same tool written the right way round. */
const answersWithFailure: Tool = {
  ...throwsOnMissing,
  description: 'Read a file. Says so when it is not there.',
  execute: (args) => ({
    content: `"${String(args['path'])}" does not exist`,
    isError: true,
  }),
}

/**
 * A provider that enforces the rule OpenAI and DeepSeek both enforce.
 *
 * Word for word the refusal a real one returns, because the point of the test
 * is that the sentence is recognisable when somebody meets it for real.
 *
 * @returns a `fetch` that answers 400 for an unanswered call, 200 otherwise.
 */
function strictProvider(): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: {
        role: string
        tool_calls?: { id: string }[]
        tool_call_id?: string
      }[]
    }
    const answered = new Set(
      body.messages.filter((message) => message.role === 'tool').map((m) => m.tool_call_id),
    )
    const dangling = body.messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id) => !answered.has(id))

    if (dangling.length > 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${dangling.join(', ')}`,
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }

    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

/** The log a throwing `execute` leaves behind, written out by hand. */
function unbalancedLog(): SessionLog {
  const log = new SessionLog()
  log.append('user/message', { id: 'm1', text: 'read notes/missing.md please' })
  log.append('assistant/message', {
    id: 'm1',
    step: 0,
    text: '',
    reason: 'tool_calls',
    chunks: 0,
    reasoningChunks: 0,
    toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes/missing.md"}' }],
    reasoning: '',
  })
  // …and then the exception unwound, and nothing was ever appended for it.
  log.append('tool/call', {
    id: 'm1',
    step: 0,
    callId: 'call_1',
    name: 'read_file',
    arguments: '{"path":"notes/missing.md"}',
  })
  return log
}

async function send(messages: readonly ModelMessage[]): Promise<string> {
  const adapter = createOpenAiAdapter({
    model: 'strict',
    apiKey: 'not-used',
    fetch: strictProvider(),
    name: 'provider',
  })
  try {
    // Drained rather than inspected: the failure is in getting the stream at
    // all, so what it carries when it succeeds does not matter here.
    const stream = adapter.stream(messages, {
      tools: [{ name: 'read_file', description: 'Read a file.', parameters: {} }],
    })
    const chunks = stream[Symbol.asyncIterator]()
    while (!(await chunks.next()).done) continue
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('a tool that throws', () => {
  it('kills the turn, which is the half everybody notices', async () => {
    const registry = createToolRegistry([throwsOnMissing])
    const tool = registry.get('read_file')

    expect(() => tool?.execute({ path: 'notes/missing.md' }, {})).toThrow(/ENOENT/)
  })

  it('leaves a tool/call that nothing answers, which is the half that costs', () => {
    const log = unbalancedLog()

    expect(log.events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
    expect(log.events.filter((event) => event.type === 'tool/result')).toHaveLength(0)
  })

  it('derives to a history with a call and no reply to it', () => {
    const log = unbalancedLog()

    expect(deriveMessages(log)).toEqual([
      { role: 'user', content: 'read notes/missing.md please' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes/missing.md"}' }],
      },
    ])
  })

  it('poisons the session: the provider refuses that history outright', async () => {
    // Not "the failed message failed". Every message after it fails too, for
    // as long as the session exists, because the request is folded out of a
    // log that is now permanently malformed. An append cannot be taken back.
    const refusal = await send(deriveMessages(unbalancedLog()))

    expect(refusal).toContain('400')
    expect(refusal).toContain('did not have response messages: call_1')
  })
})

describe('a tool that fails', () => {
  it('is an ordinary result, and the turn carries on', async () => {
    const log = new SessionLog()
    const tools = createToolRegistry([answersWithFailure])
    let step = 0
    const adapter = createScriptedAdapter({
      reportUsage: false,
      reply: () =>
        step++ === 0
          ? {
              text: '',
              toolCalls: [
                { id: 'call_1', name: 'read_file', arguments: '{"path":"notes/missing.md"}' },
              ],
            }
          : 'That file is not there. Shall I list the directory instead?',
    })

    const result = await recordExchange({
      log,
      adapter,
      tools,
      text: 'read notes/missing.md please',
      newId: () => 'm1',
    })

    expect(result.text).toBe('That file is not there. Shall I list the directory instead?')
    expect(result.steps).toBe(2)
  })

  it('balances the log, so the next message is not doomed', async () => {
    const log = new SessionLog()
    const tools = createToolRegistry([answersWithFailure])
    let step = 0
    const adapter = createScriptedAdapter({
      reportUsage: false,
      reply: () =>
        step++ === 0
          ? {
              text: '',
              toolCalls: [
                { id: 'call_1', name: 'read_file', arguments: '{"path":"notes/missing.md"}' },
              ],
            }
          : 'not there',
    })

    await recordExchange({ log, adapter, tools, text: 'read it', newId: () => 'm1' })

    expect(log.events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
    expect(log.events.filter((event) => event.type === 'tool/result')).toHaveLength(1)
    expect(await send(deriveMessages(log))).toBe('accepted')
  })

  it('tells the model what went wrong, in the one place the model reads', async () => {
    const log = new SessionLog()
    const tools = createToolRegistry([answersWithFailure])
    let step = 0
    const adapter = createScriptedAdapter({
      reportUsage: false,
      reply: () =>
        step++ === 0
          ? {
              text: '',
              toolCalls: [
                { id: 'call_1', name: 'read_file', arguments: '{"path":"notes/missing.md"}' },
              ],
            }
          : 'understood',
    })

    await recordExchange({ log, adapter, tools, text: 'read it', newId: () => 'm1' })

    // `isError` is for the human in the inspector. A provider has no field for
    // "this result is bad news", so the news itself has to be the content.
    expect(deriveMessages(log).at(-2)).toEqual({
      role: 'tool',
      content: '"notes/missing.md" does not exist',
      toolCallId: 'call_1',
    })
    expect(log.events.find((event) => event.type === 'tool/result')?.data['isError']).toBe(true)
  })
})
