/**
 * The acceptance criteria for step #7, asserted through a real socket.
 *
 * The first one is the whole point of the step and cannot be checked anywhere
 * else: *ask what is in a directory, and get an answer that came from the
 * filesystem.* Every layer has to be right at once — schemas going out, calls
 * coming back, a tool running, its result folding into the next request — so
 * this is the test that would notice if any one of them were wired wrong.
 *
 * The directory read is a real one, made in a temp dir, because a tool that
 * only works against a mock filesystem is not a tool.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScriptedAdapter } from '@harness/llm'
import { createToolRegistry } from '@harness/tools'
import { createFileTools } from '@harness/tools/fs'
import { createHarnessServer } from '../src/server.ts'
import type { HarnessServer } from '../src/server.ts'

let harness: HarnessServer
let origin: string
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-tools-'))
  await writeFile(join(root, 'notes.md'), '# notes\nthe kettle is on\n')
  await writeFile(join(root, 'index.ts'), 'export {}\n')

  harness = createHarnessServer({
    // The default scripted adapter calls a tool whose name appears in what was
    // said, then answers from the result. Enough to exercise every seam
    // without a key or a network.
    adapter: createScriptedAdapter(),
    tools: createToolRegistry(createFileTools({ root })),
    heartbeatMs: 0,
  })
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await harness.close()
  await rm(root, { recursive: true, force: true })
})

interface MessageResponse {
  readonly text: string
  readonly steps: number
  readonly toolCalls: number
  readonly stoppedAtLimit: boolean
}

async function say(text: string): Promise<MessageResponse> {
  const response = await fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as MessageResponse
}

function eventsOfType(type: string) {
  return harness.log.events.filter((event) => event.type === type)
}

describe('asking what is in a directory', () => {
  it('answers from the filesystem, not from the model', async () => {
    const result = await say('list_directory for the root please')

    // The filenames are in the reply because a real `readdir` put them there.
    expect(result.text).toContain('notes.md')
    expect(result.text).toContain('index.ts')
    expect(result.toolCalls).toBe(1)
    expect(result.steps).toBe(2)
  })

  it('reads a file the same way', async () => {
    // The arguments are written out because the scripted adapter does not
    // guess them — a real model would. Everything after them is identical.
    const result = await say('read_file {"path":"notes.md"}')

    expect(result.text).toContain('the kettle is on')
  })

  it('runs one more request than it made tool calls', async () => {
    await say('list_directory for the root please')

    // Two `assistant/message` events under one exchange id: the step is what
    // tells them apart, and issue #8 turns that into a state machine.
    expect(eventsOfType('assistant/message').map((event) => event.data['step'])).toEqual([0, 1])
  })
})

describe('the log the run leaves', () => {
  it('pairs every call with exactly one result, in order', async () => {
    await say('list_directory for the root please')
    await say('read_file {"path":"notes.md"}')

    const pairs = harness.log.events
      .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
      .map((event) => `${event.type} ${String(event.data['callId'])}`)

    // The second acceptance criterion, and the invariant the whole step turns
    // on: never two calls in a row, never a result without its call.
    expect(pairs).toEqual([
      'tool/call call_1',
      'tool/result call_1',
      'tool/call call_2',
      'tool/result call_2',
    ])
  })

  it('holds enough to reconstruct the call without the tool', async () => {
    await say('list_directory {"path":"."}')
    const [call] = eventsOfType('tool/call')
    const [outcome] = eventsOfType('tool/result')

    // The third acceptance criterion: arguments and result readable from the
    // log alone. Nothing here is a reference to state held elsewhere.
    expect(call?.data['name']).toBe('list_directory')
    expect(JSON.parse(String(call?.data['arguments']))).toEqual({ path: '.' })
    expect(outcome?.data['callId']).toBe(call?.data['callId'])
    expect(String(outcome?.data['content'])).toContain('notes.md')
    expect(outcome?.data['isError']).toBe(false)
  })

  it('records a failure as a result, and carries on', async () => {
    const result = await say('read_file {"path":"nope.md"}')

    expect(eventsOfType('tool/result')).toHaveLength(1)
    expect(eventsOfType('tool/result')[0]?.data['isError']).toBe(true)
    // The turn finished. That is the difference the step is about.
    expect(result.text.length).toBeGreaterThan(0)
    expect(eventsOfType('error/stream')).toHaveLength(0)
  })
})

describe('a server with no tools', () => {
  it('still converses', async () => {
    const bare = createHarnessServer({ tools: createToolRegistry([]), heartbeatMs: 0 })
    await new Promise<void>((resolve) => bare.server.listen(0, '127.0.0.1', resolve))
    const address = bare.server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')

    const response = await fetch(`http://127.0.0.1:${address.port}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'list_directory for the root please' }),
    })
    const result = (await response.json()) as MessageResponse

    expect(result.steps).toBe(1)
    expect(result.toolCalls).toBe(0)
    expect(bare.log.events.filter((event) => event.type === 'tool/call')).toHaveLength(0)
    await bare.close()
  })
})
