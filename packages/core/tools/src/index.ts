/**
 * The registry, and the one function that runs a call against it.
 *
 * A registry is a map with opinions: names are unique, the order tools were
 * registered in is the order the model is shown them in, and the schemas it
 * hands out are the same objects that go on the wire. Nothing here touches the
 * session log — `@harness/exchange` writes down what this package returns.
 *
 * @module @harness/tools
 */

import type { JsonObject } from '@harness/session'
import type { ToolCall, ToolSchema } from '@harness/llm'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export type { Tool, ToolContext, ToolResult } from './types.ts'
export type { ToolCall, ToolSchema } from '@harness/llm'

/**
 * The tools on the table.
 *
 * Read-only by design. Registering happens once, when the harness is built,
 * because a registry that changes between the request that advertised it and
 * the reply that answers it is a model being told about a tool that no longer
 * exists. Later steps hang policy off the *call*, never off the table.
 */
export interface ToolRegistry {
  /** Every tool, in registration order. */
  list(): readonly Tool[]
  /** Whether a name is on the table. */
  has(name: string): boolean
  /** One tool by name, or `undefined` — which {@link runTool} turns into a result. */
  get(name: string): Tool | undefined
  /**
   * What the provider is told, in registration order.
   *
   * The same array every call, frozen, because it is sent with every request
   * and rebuilding it per request would be allocating the identical bytes on a
   * loop.
   */
  schemas(): readonly ToolSchema[]
}

/**
 * Build a registry from a list of tools.
 *
 * @param tools - the tools, in the order the model should see them.
 * @returns the registry.
 * @throws when two tools share a name. A duplicate is unresolvable rather than
 *   merely untidy: the model would call one and the harness would run whichever
 *   won, and nothing downstream could tell which.
 */
export function createToolRegistry(tools: readonly Tool[] = []): ToolRegistry {
  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new TypeError(`two tools are named "${tool.name}"`)
    byName.set(tool.name, tool)
  }

  const ordered = Object.freeze([...tools])
  const schemas = Object.freeze(
    ordered.map((tool) =>
      Object.freeze({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    ),
  )

  return {
    list: () => ordered,
    has: (name) => byName.has(name),
    get: (name) => byName.get(name),
    schemas: () => schemas,
  }
}

/** A registry with nothing in it. Shared, because it holds nothing. */
export const EMPTY_TOOL_REGISTRY: ToolRegistry = createToolRegistry()

/**
 * Run one call and produce one result. Always.
 *
 * This function does not throw, and that is not a style preference — it is the
 * invariant the log depends on. `@harness/exchange` appends a `tool/call`
 * before calling this and a `tool/result` after, so anything that escapes here
 * leaves the log holding half a pair. A provider handed that history rejects
 * the request outright, which means one unlucky `ENOENT` does not fail a turn:
 * it poisons the session, permanently, and the symptom arrives on the *next*
 * message.
 *
 * So every way this can go wrong is a result:
 *
 * - the tool does not exist — the model invented a name, or the table changed;
 * - the arguments are not JSON — models do emit malformed JSON;
 * - the arguments are JSON but not an object — `"hello"` is valid JSON;
 * - `execute` threw, rejected, or was aborted.
 *
 * Note what is *not* checked: the arguments against the schema. A validator is
 * a dependency and a decision, and the pipeline that will own it is its own
 * step; until then a tool checks what it needs and says so in its result,
 * which is the same shape of answer either way.
 *
 * @param registry - the tools on the table.
 * @param call - what the model asked for, arguments still unparsed.
 * @param context - cancellation, passed through to the tool.
 * @returns what to tell the model. Never rejects.
 */
export async function runTool(
  registry: ToolRegistry,
  call: ToolCall,
  context: ToolContext = {},
): Promise<ToolResult> {
  const tool = registry.get(call.name)
  if (tool === undefined) {
    const known = registry
      .list()
      .map((candidate) => candidate.name)
      .join(', ')
    return failure(
      `there is no tool named "${call.name}". Available: ${known === '' ? '(none)' : known}`,
    )
  }

  const args = parseArguments(call.arguments)
  if (args === undefined) {
    return failure(
      `the arguments for "${call.name}" are not a JSON object: ${truncate(call.arguments)}`,
    )
  }

  try {
    const result = await tool.execute(args, context)
    return normalise(result)
  } catch (error) {
    // Including an abort. A cancelled tool has still produced an outcome, and
    // the call it answers is already in the log waiting for one.
    return failure(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Parse a call's arguments, or say they were not parseable.
 *
 * Empty text means no arguments: a provider streams `""` for a tool that takes
 * none, and refusing that would fail every zero-argument call.
 *
 * @param raw - the JSON text the provider streamed.
 * @returns the arguments, or `undefined` when they are not a JSON object.
 */
export function parseArguments(raw: string): JsonObject | undefined {
  const text = raw.trim()
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as JsonObject
}

/** A failure, in the one shape every failure takes. */
function failure(content: string): ToolResult {
  return Object.freeze({ content, isError: true })
}

/**
 * Take a tool at its word, but not on trust.
 *
 * A tool is ordinary code somebody wrote, and a result whose `content` is
 * `undefined` would reach the model as the string `"undefined"` and reach the
 * log as an invalid payload. Cheaper to insist here than to debug there.
 *
 * @param result - whatever `execute` returned.
 * @returns a frozen, well-formed result.
 */
function normalise(result: ToolResult): ToolResult {
  if (typeof result?.content !== 'string') {
    return failure('the tool returned something that is not a result')
  }
  return Object.freeze({ content: result.content, isError: result.isError === true })
}

/** Keep a malformed argument blob out of the log at full length. */
function truncate(text: string, limit = 200): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
