/**
 * The loop: a model that asks for a tool, and an answer built from what came
 * back.
 *
 * The acceptance criteria of this step, one `describe` each. Two of them are
 * about the *log* rather than about the answer, and those are the ones with
 * teeth: a harness whose replies read well and whose log does not balance is a
 * harness that breaks on the second message rather than the first.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '@harness/session'
import type { SessionEvent } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter, ModelMessage, ScriptedReply, ToolSchema } from '@harness/llm'
import { createToolRegistry } from '@harness/tools'
import type { Tool } from '@harness/tools'
import { createFileTools } from '@harness/tools/fs'
import { DEFAULT_MAX_STEPS, recordExchange } from '../src/exchange.ts'
import { deriveMessages } from '../src/messages.ts'
import { EXCHANGE_EVENT_TYPES } from '../src/types.ts'

/** Ids a test can assert on. */
function counter(): () => string {
  let next = 0
  return () => `m${(next += 1)}`
}

function typesOf(log: SessionLog): string[] {
  return log.events.map((event) => event.type)
}

function eventsOf(log: SessionLog, type: string): readonly SessionEvent[] {
  return log.events.filter((event) => event.type === type)
}

/** A workspace with something worth listing in it. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-loop-'))
  writeFileSync(join(root, 'notes.md'), 'the log is the file\n')
  writeFileSync(join(root, 'todo.md'), 'nothing\n')
  return root
}

/** A tool that records what it was given and answers with a fixed string. */
function spy(name: string, content: string): { tool: Tool; seen: unknown[] } {
  const seen: unknown[] = []
  return {
    seen,
    tool: {
      name,
      description: `A tool called ${name}, for a test.`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute(args) {
        seen.push(args)
        return { content, isError: false }
      },
    },
  }
}

/**
 * An adapter that plays a fixed sequence of steps, one per request.
 *
 * Stateful on purpose: a scripted *loop* has to be able to say "call a tool,
 * then answer", and answering differently to two identical-looking requests is
 * exactly what a real model does.
 */
function scriptedSteps(steps: readonly ScriptedReply[]): {
  adapter: ModelAdapter
  requests: (readonly ModelMessage[])[]
  offered: (readonly ToolSchema[])[]
} {
  const requests: (readonly ModelMessage[])[] = []
  const offered: (readonly ToolSchema[])[] = []
  let index = 0
  const adapter = createScriptedAdapter({
    reportUsage: false,
    reply: (messages, tools) => {
      requests.push(messages)
      offered.push(tools)
      return steps[Math.min(index++, steps.length - 1)] ?? 'done'
    },
  })
  return { adapter, requests, offered }
}

describe('asking what is in a directory', () => {
  it('calls the listing tool and answers from its result', async () => {
    // The step's first acceptance criterion, end to end and with the real
    // tool: nothing here is stubbed except the model.
    const root = workspace()
    try {
      const log = new SessionLog()
      const tools = createToolRegistry(createFileTools({ root }))
      const { adapter } = scriptedSteps([
        {
          text: 'Let me look.',
          toolCalls: [{ id: 'call_1', name: 'list_directory', arguments: '{"path":"."}' }],
        },
        // The second step is a plain string, so its text can only have come
        // from the messages the loop built — see the request assertion below.
        'The directory holds notes.md and todo.md.',
      ])

      const result = await recordExchange({
        log,
        adapter,
        tools,
        text: 'what is in this directory?',
        newId: counter(),
      })

      expect(result.steps).toBe(2)
      expect(result.toolCalls).toBe(1)
      expect(result.text).toBe('The directory holds notes.md and todo.md.')
      expect(typesOf(log)).toEqual([
        'user/message',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/message',
        'tool/call',
        'tool/result',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/message',
      ])
      // The listing really happened, and the second request really carried it.
      expect(eventsOf(log, 'tool/result')[0]?.data['content']).toBe('notes.md\ntodo.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows the model the result it just produced, without anybody passing it along', async () => {
    const root = workspace()
    try {
      const log = new SessionLog()
      const tools = createToolRegistry(createFileTools({ root }))
      const { adapter, requests } = scriptedSteps([
        {
          text: '',
          toolCalls: [{ id: 'call_1', name: 'list_directory', arguments: '{}' }],
        },
        'notes.md and todo.md.',
      ])

      await recordExchange({ log, adapter, tools, text: 'list_directory please', newId: counter() })

      // Every step's request is a fresh fold of the log — which is what makes
      // this true rather than a matter of somebody having remembered to append
      // to an array.
      expect(requests[1]).toEqual([
        { role: 'user', content: 'list_directory please' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'list_directory', arguments: '{}' }],
        },
        { role: 'tool', content: 'notes.md\ntodo.md', toolCallId: 'call_1' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sends the schemas with every request, not just the first', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter, offered } = scriptedSteps([
      { toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }] },
      'done',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    expect(offered).toHaveLength(2)
    for (const schemas of offered) {
      expect(schemas.map((schema) => schema.name)).toEqual(['look'])
    }
  })

  it('offers nothing when there are no tools, which is the old behaviour exactly', async () => {
    const log = new SessionLog()
    const { adapter, offered } = scriptedSteps(['just talking'])

    const result = await recordExchange({ log, adapter, text: 'hi', newId: counter() })

    expect(offered).toEqual([[]])
    expect(result.steps).toBe(1)
    expect(result.toolCalls).toBe(0)
    expect(typesOf(log).filter((type) => type.startsWith('tool/'))).toEqual([])
  })
})

describe('the log', () => {
  it('follows every tool/call with exactly one tool/result', async () => {
    // The second acceptance criterion. Asserted by pairing rather than by
    // counting, because two calls and two results in the wrong order is a log
    // that balances and still lies.
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter } = scriptedSteps([
      {
        toolCalls: [
          { id: 'c1', name: 'look', arguments: '{}' },
          { id: 'c2', name: 'look', arguments: '{"twice":true}' },
          { id: 'c3', name: 'nope', arguments: 'not even json' },
        ],
      },
      'done',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    expectBalanced(log)
    expect(eventsOf(log, 'tool/call').map((event) => event.data['callId'])).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  it('balances even when every single call fails', async () => {
    const log = new SessionLog()
    const tools = createToolRegistry([
      {
        name: 'explodes',
        description: 'Throws, every time.',
        parameters: { type: 'object', properties: {} },
        execute() {
          throw new Error('ENOENT: no such file or directory')
        },
      },
    ])
    const { adapter } = scriptedSteps([
      {
        toolCalls: [
          { id: 'c1', name: 'explodes', arguments: '{}' },
          { id: 'c2', name: 'missing', arguments: '{}' },
          { id: 'c3', name: 'explodes', arguments: '{oops' },
        ],
      },
      'I could not do any of that.',
    ])

    const result = await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    expectBalanced(log)
    expect(eventsOf(log, 'tool/result').map((event) => event.data['isError'])).toEqual([
      true,
      true,
      true,
    ])
    // And the turn lived: three failures, one ordinary answer.
    expect(result.text).toBe('I could not do any of that.')
  })

  it('records the arguments verbatim, malformed JSON included', async () => {
    // The third acceptance criterion, at its hardest: what is in the log is
    // what the model emitted, not a tidied version of it.
    const log = new SessionLog()
    const { tool, seen } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter } = scriptedSteps([
      {
        toolCalls: [
          { id: 'c1', name: 'look', arguments: '{"path":"a/b.txt","深":true}' },
          { id: 'c2', name: 'look', arguments: '{"path": "unterminated' },
        ],
      },
      'done',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    expect(eventsOf(log, 'tool/call').map((event) => event.data['arguments'])).toEqual([
      '{"path":"a/b.txt","深":true}',
      '{"path": "unterminated',
    ])
    // Parsed exactly once, where a failure can become a result.
    expect(seen).toEqual([{ path: 'a/b.txt', 深: true }])
  })

  it('lets a call and its result be read back from the log alone', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'the answer')
    const tools = createToolRegistry([tool])
    const { adapter } = scriptedSteps([
      { toolCalls: [{ id: 'c1', name: 'look', arguments: '{"deep":{"a":[1,2]}}' }] },
      'done',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    // What a reconnecting client gets: the events, over a wire, and nothing else.
    const replayed = JSON.parse(JSON.stringify(log.events)) as SessionEvent[]
    const call = replayed.find((event) => event.type === 'tool/call')
    const answer = replayed.find((event) => event.type === 'tool/result')

    expect(call?.data).toEqual({
      id: 'm1',
      step: 0,
      callId: 'c1',
      name: 'look',
      arguments: '{"deep":{"a":[1,2]}}',
    })
    expect(answer?.data).toEqual({
      id: 'm1',
      step: 0,
      callId: 'c1',
      name: 'look',
      content: 'the answer',
      isError: false,
    })
  })

  it('numbers the steps, so two replies in one exchange stay separable', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter } = scriptedSteps([
      { text: 'one', toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }] },
      'two',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    // One id for the exchange; `step` is what tells the two replies apart.
    expect(new Set(log.events.map((event) => event.data['id']))).toEqual(new Set(['m1']))
    expect(
      eventsOf(log, 'assistant/message').map((event) => [event.data['step'], event.data['text']]),
    ).toEqual([
      [0, 'one'],
      [1, 'two'],
    ])
  })
})

describe('the step limit', () => {
  it('stops a model that answers every result with another call', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    // One step, repeated forever: the loop that would otherwise never end.
    const { adapter } = scriptedSteps([
      { toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }] },
    ])

    const result = await recordExchange({
      log,
      adapter,
      tools,
      text: 'hi',
      maxSteps: 3,
      newId: counter(),
    })

    expect(result.stoppedAtLimit).toBe(true)
    expect(result.steps).toBe(3)
    expect(result.toolCalls).toBe(3)
    expectBalanced(log)
  })

  it('writes down why it stopped, because "it just stopped" is not an answer', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter } = scriptedSteps([
      { toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }] },
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', maxSteps: 2, newId: counter() })

    expect(log.events.at(-1)?.type).toBe('error/steps')
    expect(log.events.at(-1)?.data).toEqual({
      id: 'm1',
      step: 2,
      limit: 2,
      message: 'stopped after 2 steps without a final answer',
    })
  })

  it('is a number a caller can see rather than one buried in the source', () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(1)
  })

  it('refuses a limit that is not a limit', async () => {
    const log = new SessionLog()
    const { adapter } = scriptedSteps(['hi'])

    for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
      await expect(recordExchange({ log, adapter, text: 'hi', maxSteps })).rejects.toThrow(
        /maxSteps/,
      )
    }
  })
})

describe('the reasoning rule', () => {
  // The expiry date the previous step wrote into `MESSAGE_RULES`, honoured.
  // The symptom of getting this wrong is a 400 on the *second* message of any
  // conversation that used a tool — a long way from the line that caused it.

  it('replays the reasoning when the request carried tools, as the provider requires', async () => {
    const log = new SessionLog()
    const { tool } = spy('look', 'looked')
    const tools = createToolRegistry([tool])
    const { adapter, requests } = scriptedSteps([
      {
        reasoning: 'they want a listing',
        text: '',
        toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }],
      },
      'done',
    ])

    await recordExchange({ log, adapter, tools, text: 'hi', newId: counter() })

    const assistant = requests[1]?.find((message) => message.role === 'assistant')
    expect(assistant).toMatchObject({ reasoning: 'they want a listing' })
  })

  it('leaves it out when the request carried none, because then it is refused', async () => {
    const log = new SessionLog()
    const { adapter, requests } = scriptedSteps([
      { reasoning: 'thinking', text: 'first' },
      'second',
    ])
    const newId = counter()

    await recordExchange({ log, adapter, text: 'hi', newId })
    await recordExchange({ log, adapter, text: 'again', newId })

    const assistant = requests[1]?.find((message) => message.role === 'assistant')
    expect(assistant).toEqual({ role: 'assistant', content: 'first' })
    // Still logged in full for the human, either way.
    expect(eventsOf(log, 'assistant/reasoning')).not.toHaveLength(0)
  })
})

/**
 * Every `tool/call` is followed by exactly one `tool/result`, in order.
 *
 * @param log - the log to check.
 */
function expectBalanced(log: SessionLog): void {
  // Written as one comparison rather than an assertion per event, so a broken
  // log prints the shape it actually has instead of the first place it differs.
  const pairing = log.events
    .filter(
      (event) =>
        event.type === EXCHANGE_EVENT_TYPES.toolCall ||
        event.type === EXCHANGE_EVENT_TYPES.toolResult,
    )
    .map((event) => `${event.type} ${String(event.data['callId'])}`)

  const expected = pairing
    .filter((entry) => entry.startsWith(EXCHANGE_EVENT_TYPES.toolCall))
    .flatMap((entry) => [
      entry,
      entry.replace(EXCHANGE_EVENT_TYPES.toolCall, EXCHANGE_EVENT_TYPES.toolResult),
    ])

  expect(pairing).toEqual(expected)
  expect(deriveMessages(log).filter((message) => message.role === 'tool')).toHaveLength(
    eventsOf(log, 'tool/call').length,
  )
}
