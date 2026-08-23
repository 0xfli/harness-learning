/**
 * The two read-only tools.
 *
 * Every failure here is checked as a *result* rather than as a throw, because
 * that is what the loop above depends on. The `ENOENT` case is the one the
 * issue for this step names by hand, and it is the one worth reading: a path
 * that is not there is an ordinary answer, and quite often one the model fixes
 * by itself on the next step.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, listDirectoryTool, readFileTool } from '../src/fs.ts'
import type { Tool, ToolResult } from '../src/index.ts'
import type { JsonObject } from '@harness/session'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

/** A workspace with a couple of things in it. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-tools-'))
  roots.push(root)
  writeFileSync(join(root, 'notes.md'), '# notes\nwith 世界 and a "quote"\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42\n')
  return root
}

/** Run a tool the way `runTool` would, once its arguments are parsed. */
async function run(tool: Tool, args: JsonObject): Promise<ToolResult> {
  return await tool.execute(args, {})
}

describe('read_file', () => {
  it('returns the file, byte for byte', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'notes.md' })

    expect(result).toEqual({ content: '# notes\nwith 世界 and a "quote"\n', isError: false })
  })

  it('reads through a subdirectory', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'src/index.ts' })

    expect(result.content).toBe('export const answer = 42\n')
  })

  it('answers rather than throws when the file is not there', async () => {
    // The deliberate mistake of this step, closed. Throwing here kills the
    // turn and leaves the log holding a tool/call nothing answers.
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'nowhere.md' })

    expect(result).toEqual({ content: '"nowhere.md" does not exist', isError: true })
  })

  it('says so, in words, when handed a directory', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'src' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('list_directory')
  })

  it('refuses a file bigger than the limit rather than filling the context with it', async () => {
    const root = workspace()
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2048))

    const result = await run(readFileTool({ root, maxBytes: 1024 }), { path: 'big.txt' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('over the 1024-byte limit')
  })

  it('needs a path, and says which argument was missing', async () => {
    const root = workspace()

    expect(await run(readFileTool({ root }), {})).toEqual({
      content: '"path" is required and must be a non-empty string',
      isError: true,
    })
    expect((await run(readFileTool({ root }), { path: 42 })).isError).toBe(true)
  })

  it('keeps the absolute path out of what the model is told', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'nowhere.md' })

    // Node's own message carries the resolved path, which is both noise and a
    // description of where the harness happens to be running.
    expect(result.content).not.toContain(root)
  })
})

describe('list_directory', () => {
  it('lists the root when asked for nothing', async () => {
    const root = workspace()

    const result = await run(listDirectoryTool({ root }), {})

    expect(result).toEqual({ content: 'notes.md\nsrc/', isError: false })
  })

  it('marks directories with a trailing slash, so the model can tell them apart', async () => {
    const root = workspace()

    const result = await run(listDirectoryTool({ root }), { path: '.' })

    expect(result.content.split('\n')).toEqual(['notes.md', 'src/'])
  })

  it('lists a subdirectory', async () => {
    const root = workspace()

    expect(await run(listDirectoryTool({ root }), { path: 'src' })).toEqual({
      content: 'index.ts',
      isError: false,
    })
  })

  it('says a directory is empty rather than answering with nothing at all', async () => {
    const root = workspace()
    mkdirSync(join(root, 'empty'))

    expect(await run(listDirectoryTool({ root }), { path: 'empty' })).toEqual({
      content: '"empty" is empty',
      isError: false,
    })
  })

  it('truncates a directory nobody would read, and says how much it left out', async () => {
    const root = workspace()
    mkdirSync(join(root, 'many'))
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(root, 'many', `file-${index}.txt`), '')
    }

    const result = await run(listDirectoryTool({ root, maxEntries: 3 }), { path: 'many' })

    expect(result.isError).toBe(false)
    expect(result.content.split('\n')).toHaveLength(4)
    expect(result.content).toContain('and 7 more, not shown')
  })

  it('answers rather than throws when the directory is not there', async () => {
    const root = workspace()

    expect(await run(listDirectoryTool({ root }), { path: 'nowhere' })).toEqual({
      content: '"nowhere" does not exist',
      isError: true,
    })
  })

  it('answers rather than throws when the path is a file', async () => {
    const root = workspace()

    const result = await run(listDirectoryTool({ root }), { path: 'notes.md' })

    expect(result).toEqual({ content: '"notes.md" is not a directory', isError: true })
  })
})

describe('the workspace root', () => {
  // Not the filesystem guardrail this project is going to need — that one is
  // identity-based, knows about symlinks, and has a step of its own. This is
  // the part that is four lines and would be negligent to leave out in the
  // meantime.

  it('refuses a path that climbs out with ..', async () => {
    const root = workspace()

    const paths = ['../secrets', '../../etc/passwd', 'src/../../outside']
    const results = await Promise.all(paths.map((path) => run(readFileTool({ root }), { path })))

    expect(
      results.map(
        (result, index) =>
          `${paths[index]} · ${result.isError} · ${result.content.includes('outside the workspace root')}`,
      ),
    ).toEqual([
      '../secrets · true · true',
      '../../etc/passwd · true · true',
      'src/../../outside · true · true',
    ])
  })

  it('refuses an absolute path, however innocent it looks', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: '/etc/hosts' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('outside the workspace root')
  })

  it('allows a path that goes out and comes back, because it never left', async () => {
    const root = workspace()

    const result = await run(readFileTool({ root }), { path: 'src/../notes.md' })

    expect(result.isError).toBe(false)
  })

  it('allows the root itself', async () => {
    const root = workspace()

    expect((await run(listDirectoryTool({ root }), { path: '..' })).isError).toBe(true)
    expect((await run(listDirectoryTool({ root }), { path: '.' })).isError).toBe(false)
  })
})

describe('the pair of them', () => {
  it('is what a harness starts with: read, and look around', () => {
    expect(createFileTools().map((tool) => tool.name)).toEqual(['read_file', 'list_directory'])
  })

  it('describes itself to the model, because the description is the only documentation there is', () => {
    expect(
      createFileTools().map(
        (tool) =>
          `${tool.name} · ${tool.description.length > 40} · ${String(tool.parameters['type'])}`,
      ),
    ).toEqual(['read_file · true · object', 'list_directory · true · object'])
  })
})
