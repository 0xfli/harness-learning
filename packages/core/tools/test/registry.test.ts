/**
 * The registry, and the promise that running a call always produces a result.
 *
 * The second half is the one that matters. `runTool` is documented as never
 * rejecting, and `@harness/exchange` appends a `tool/result` on the strength
 * of that documentation alone — no `try`, no `finally`. So these tests are not
 * checking a convenience: they are checking the thing that keeps the session
 * log balanced, and every one of them is a way the naive version throws.
 */

import { describe, expect, it } from 'vitest'
import { createToolRegistry, EMPTY_TOOL_REGISTRY, parseArguments, runTool } from '../src/index.ts'
import type { Tool, ToolResult } from '../src/index.ts'

/** A tool that answers with whatever it was given. */
function echo(name = 'echo', result?: () => ToolResult): Tool {
  return {
    name,
    description: `Echo, called ${name}.`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: (args) => result?.() ?? { content: JSON.stringify(args), isError: false },
  }
}

function call(name: string, args = '{}'): { id: string; name: string; arguments: string } {
  return { id: 'call_1', name, arguments: args }
}

describe('a registry', () => {
  it('keeps the order tools were registered in, because that is the order the model reads', () => {
    const registry = createToolRegistry([echo('b'), echo('a'), echo('c')])

    expect(registry.list().map((tool) => tool.name)).toEqual(['b', 'a', 'c'])
    expect(registry.schemas().map((schema) => schema.name)).toEqual(['b', 'a', 'c'])
  })

  it('hands out the same frozen schemas every time, because they are sent every request', () => {
    const registry = createToolRegistry([echo()])

    expect(registry.schemas()).toBe(registry.schemas())
    expect(Object.isFrozen(registry.schemas())).toBe(true)
    expect(Object.isFrozen(registry.schemas()[0])).toBe(true)
  })

  it('publishes exactly the name, description and schema — nothing of the implementation', () => {
    const registry = createToolRegistry([echo('read_file')])

    expect(registry.schemas()[0]).toEqual({
      name: 'read_file',
      description: 'Echo, called read_file.',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    })
  })

  it('refuses two tools with one name, because nothing downstream could tell them apart', () => {
    expect(() => createToolRegistry([echo('same'), echo('same')])).toThrow(/two tools are named/)
  })

  it('answers has and get without pretending', () => {
    const registry = createToolRegistry([echo('here')])

    expect(registry.has('here')).toBe(true)
    expect(registry.has('nowhere')).toBe(false)
    expect(registry.get('nowhere')).toBeUndefined()
  })

  it('is empty when nothing was registered, and says so with an empty schema list', () => {
    expect(EMPTY_TOOL_REGISTRY.list()).toEqual([])
    // Which is what makes "send no `tools` field at all" expressible: an empty
    // list is the signal, not a special case somebody has to remember.
    expect(EMPTY_TOOL_REGISTRY.schemas()).toEqual([])
  })
})

describe('running a call', () => {
  it('returns what the tool returned', async () => {
    const registry = createToolRegistry([echo()])

    const result = await runTool(registry, call('echo', '{"a":1}'))

    expect(result).toEqual({ content: '{"a":1}', isError: false })
  })

  it('treats empty arguments as no arguments, which is what a provider streams', async () => {
    const registry = createToolRegistry([echo()])

    expect(await runTool(registry, call('echo', ''))).toEqual({ content: '{}', isError: false })
  })

  it('freezes the result, because it is about to become an event', async () => {
    const registry = createToolRegistry([echo()])

    expect(Object.isFrozen(await runTool(registry, call('echo')))).toBe(true)
  })
})

describe('every way a call can go wrong', () => {
  // One `it` per way the naive version throws. All five produce a result, and
  // that is the whole invariant this package exists to hold up.

  it('is a result when the tool does not exist', async () => {
    const registry = createToolRegistry([echo('read_file')])

    const result = await runTool(registry, call('read_flie'))

    expect(result.isError).toBe(true)
    // Named, and the alternatives listed: a model that misspelled a name can
    // fix it on the next step, which is the entire reason this is a result.
    expect(result.content).toContain('read_flie')
    expect(result.content).toContain('read_file')
  })

  it('is a result when there are no tools at all', async () => {
    const result = await runTool(EMPTY_TOOL_REGISTRY, call('anything'))

    expect(result).toEqual({
      content: 'there is no tool named "anything". Available: (none)',
      isError: true,
    })
  })

  it('is a result when the arguments are not JSON, which models do emit', async () => {
    const registry = createToolRegistry([echo()])

    const result = await runTool(registry, call('echo', '{"path": "a.txt'))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a JSON object')
  })

  it('is a result when the arguments are JSON but not an object', async () => {
    const registry = createToolRegistry([echo()])

    const args = ['"hello"', '[1,2]', 'null', '42']
    const results = await Promise.all(args.map((json) => runTool(registry, call('echo', json))))

    expect(results.map((result, index) => `${args[index]} · ${result.isError}`)).toEqual([
      '"hello" · true',
      '[1,2] · true',
      'null · true',
      '42 · true',
    ])
  })

  it('is a result when execute throws', async () => {
    const registry = createToolRegistry([
      {
        ...echo('boom'),
        execute: () => {
          throw new Error('ENOENT: no such file or directory')
        },
      },
    ])

    const result = await runTool(registry, call('boom'))

    expect(result).toEqual({ content: 'ENOENT: no such file or directory', isError: true })
  })

  it('is a result when execute rejects', async () => {
    const registry = createToolRegistry([
      { ...echo('slow'), execute: () => Promise.reject(new Error('the socket closed')) },
    ])

    expect(await runTool(registry, call('slow'))).toEqual({
      content: 'the socket closed',
      isError: true,
    })
  })

  it('is a result when the call is aborted, because an aborted tool still has an outcome', async () => {
    const controller = new AbortController()
    const registry = createToolRegistry([
      {
        ...echo('waits'),
        execute: (_args, context) =>
          new Promise<ToolResult>((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'))
            })
          }),
      },
    ])

    const running = runTool(registry, call('waits'), { signal: controller.signal })
    controller.abort()

    expect(await running).toEqual({ content: 'aborted', isError: true })
  })

  it('is a result when the tool returns something that is not one', async () => {
    const registry = createToolRegistry([
      // Ordinary code somebody wrote, and a `content` of `undefined` would
      // reach the model as the string "undefined" and the log as an invalid
      // payload.
      { ...echo('wrong'), execute: () => ({}) as unknown as ToolResult },
    ])

    const result = await runTool(registry, call('wrong'))

    expect(result).toEqual({
      content: 'the tool returned something that is not a result',
      isError: true,
    })
  })

  it('never rejects, whatever is thrown at it', async () => {
    // The invariant stated once, over every case above at once. If this ever
    // fails, the session log can be left holding a tool/call that nothing
    // answers — see `test/unbalanced-history.test.ts` in `@harness/exchange`
    // for what that costs.
    const registry = createToolRegistry([
      {
        ...echo('hostile'),
        execute: () => {
          throw 'a string, not an Error'
        },
      },
    ])

    await expect(runTool(registry, call('hostile'))).resolves.toEqual({
      content: 'a string, not an Error',
      isError: true,
    })
    await expect(runTool(registry, call('missing'))).resolves.toBeDefined()
    await expect(runTool(registry, call('hostile', 'not json'))).resolves.toBeDefined()
  })
})

describe('parsing arguments', () => {
  it('accepts an object, and only an object', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseArguments('  ')).toEqual({})
    expect(parseArguments('[]')).toBeUndefined()
    expect(parseArguments('"a"')).toBeUndefined()
    expect(parseArguments('null')).toBeUndefined()
    expect(parseArguments('{')).toBeUndefined()
  })
})
