/**
 * The first two tools: read a file, list a directory.
 *
 * Both read-only, and that is the whole of the guardrail story at this step.
 * There is no shell here and there will not be one until something can say no
 * to it — a model that can run commands before there is a policy layer is a
 * model that can run any command.
 *
 * The one rule they do enforce is containment: every path resolves inside a
 * root, and one that climbs out is refused. That is not the filesystem
 * guardrail this project is going to need — real containment is identity-based
 * and knows about symlinks, and it has a step of its own — but a tool reachable
 * from an HTTP request that will read `/etc/passwd` on request is not a thing
 * to leave lying around in the meantime.
 *
 * This is the only module in the package that imports `node:fs`, which is why
 * it is behind its own entry point: `@harness/tools` is vocabulary the browser
 * can read, `@harness/tools/fs` is a capability only a server has.
 *
 * @module @harness/tools/fs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { JsonObject } from '@harness/session'
import type { Tool, ToolResult } from './types.ts'

/** Where the read-only tools are allowed to look. */
export interface FileToolOptions {
  /** The directory paths resolve against, and may not climb out of. */
  readonly root?: string
  /** Largest file `read_file` will return, in bytes. */
  readonly maxBytes?: number
  /** Most entries `list_directory` will return. */
  readonly maxEntries?: number
}

/** Enough to read any source file here, small enough not to fill a context. */
const DEFAULT_MAX_BYTES = 64 * 1024

/** A directory with more entries than this is a directory nobody reads. */
const DEFAULT_MAX_ENTRIES = 200

/**
 * Both read-only tools, rooted at one directory.
 *
 * @param options - the root and the limits.
 * @returns the tools, in the order the model should see them.
 */
export function createFileTools(options: FileToolOptions = {}): readonly Tool[] {
  return [readFileTool(options), listDirectoryTool(options)]
}

/**
 * Read a file, as text.
 *
 * @param options - the root and the size limit.
 * @returns the tool.
 */
export function readFileTool(options: FileToolOptions = {}): Tool {
  const root = resolve(options.root ?? process.cwd())
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return {
    name: 'read_file',
    description:
      'Read a UTF-8 text file and return its contents. The path is relative to the workspace root. Returns an error result if the file does not exist, is a directory, or is too large.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the workspace root.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute(args: JsonObject): ToolResult {
      const requested = args['path']
      if (typeof requested !== 'string' || requested.trim().length === 0) {
        return error('"path" is required and must be a non-empty string')
      }

      const target = contain(root, requested)
      if (target === undefined) return error(outsideRoot(requested))

      try {
        const stats = statSync(target)
        if (stats.isDirectory()) {
          return error(`"${requested}" is a directory. Use list_directory for it.`)
        }
        if (stats.size > maxBytes) {
          return error(`"${requested}" is ${stats.size} bytes, over the ${maxBytes}-byte limit`)
        }
        return ok(readFileSync(target, 'utf8'))
      } catch (cause) {
        // The one that mattered enough to be written into the issue: a path
        // that is not there is an answer, not an exception. The model reads
        // it, and quite often fixes it by itself on the next step.
        return error(describe(cause, requested))
      }
    },
  }
}

/**
 * List a directory, marking which entries are directories.
 *
 * @param options - the root and the entry limit.
 * @returns the tool.
 */
export function listDirectoryTool(options: FileToolOptions = {}): Tool {
  const root = resolve(options.root ?? process.cwd())
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  return {
    name: 'list_directory',
    description:
      'List the entries of a directory, one per line, with a trailing slash on directories. The path is relative to the workspace root and defaults to the root itself.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory, relative to the workspace root. Defaults to ".".',
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute(args: JsonObject): ToolResult {
      const requested = args['path']
      if (requested !== undefined && typeof requested !== 'string') {
        return error('"path" must be a string when given')
      }
      const asked = requested === undefined || requested.trim().length === 0 ? '.' : requested

      const target = contain(root, asked)
      if (target === undefined) return error(outsideRoot(asked))

      try {
        const entries = readdirSync(target, { withFileTypes: true })
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .toSorted((left, right) => left.localeCompare(right))
        if (entries.length === 0) return ok(`"${asked}" is empty`)
        const shown = entries.slice(0, maxEntries)
        const note =
          entries.length > shown.length
            ? `\n… and ${entries.length - shown.length} more, not shown`
            : ''
        return ok(shown.join('\n') + note)
      } catch (cause) {
        return error(describe(cause, asked))
      }
    },
  }
}

/**
 * Resolve a path inside the root, or refuse it.
 *
 * Compares the *resolved* paths rather than looking for `..` in the text,
 * because `a/../../b` contains no leading `..` and still leaves. This is the
 * cheap half of containment and it does not follow symlinks — a link inside
 * the root pointing out of it is resolved by the kernel, not by `resolve`.
 * Closing that is the filesystem guardrail step's job.
 *
 * @param root - the resolved root.
 * @param requested - the path as the model wrote it.
 * @returns the absolute path, or `undefined` when it escapes.
 */
function contain(root: string, requested: string): string | undefined {
  const target = resolve(root, requested)
  if (target === root) return target
  const inside = relative(root, target)
  if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return undefined
  return target
}

function outsideRoot(requested: string): string {
  return `"${requested}" is outside the workspace root, so it cannot be read`
}

/**
 * Say what went wrong in words the model can act on.
 *
 * Node's `code` is the useful part and its message repeats the path back with
 * the absolute path in it, which is both noise and a leak of where the harness
 * happens to be running.
 *
 * @param cause - whatever the filesystem threw.
 * @param requested - the path as the model wrote it.
 * @returns a one-line explanation.
 */
function describe(cause: unknown, requested: string): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
      return `"${requested}" does not exist`
    case 'ENOTDIR':
      return `"${requested}" is not a directory`
    case 'EISDIR':
      return `"${requested}" is a directory`
    case 'EACCES':
    case 'EPERM':
      return `"${requested}" cannot be read: permission denied`
    default:
      return `"${requested}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function ok(content: string): ToolResult {
  return Object.freeze({ content, isError: false })
}

function error(content: string): ToolResult {
  return Object.freeze({ content, isError: true })
}
