/**
 * What a tool is, and what running one produces.
 *
 * The shape here is four fields — a name, a description, a schema and a
 * function — and only the last of them is interesting. `execute` returns a
 * {@link ToolResult} and is documented as never throwing on the model's
 * behalf, which is this package's whole opinion in one sentence.
 *
 * @module
 */

import type { JsonObject } from '@harness/session'

/**
 * What a tool said back.
 *
 * `isError` rather than an exception, and that distinction is the point of
 * this step. A tool that cannot do what it was asked has not crashed the
 * harness: it has produced a normal, useful, model-facing answer, and one the
 * model is often perfectly able to recover from — the file was not there, so
 * list the directory and try again. Modelling that as a thrown error means the
 * turn dies, the model never learns what went wrong, and the log is left with
 * a `tool/call` that nothing ever answered. See
 * `docs/adr/0011-a-failing-tool-is-a-result.md`.
 */
export interface ToolResult {
  /** What the model is told. Prose, or whatever serialisation suits. */
  readonly content: string
  /** Whether that content is a failure. Both kinds are recorded the same way. */
  readonly isError: boolean
}

/** What a tool is given besides its arguments. */
export interface ToolContext {
  /**
   * Aborts the work.
   *
   * A tool that honours it should still *return*: an aborted tool is a tool
   * that produced an error result, and the call it answers is already in the
   * log waiting for one.
   */
  readonly signal?: AbortSignal
}

/**
 * One thing the model can do.
 *
 * `parameters` is a JSON Schema, and it is written by hand rather than
 * generated. That is a deliberate cost: the schema is the only documentation
 * the model gets, so it is prose aimed at a reader, and a `description` on
 * each property is worth more than a clever type.
 */
export interface Tool {
  /** What the model calls it. Unique within a registry. */
  readonly name: string
  /** What it does, and when to reach for it. Written for the model. */
  readonly description: string
  /** JSON Schema for the arguments. */
  readonly parameters: JsonObject
  /**
   * Do the thing.
   *
   * @param args - the parsed arguments. Already JSON, never validated against
   *   the schema — see {@link runTool} for why that check is not here.
   * @param context - cancellation, and whatever later steps add.
   * @returns what to tell the model, including when that is bad news.
   */
  execute(args: JsonObject, context: ToolContext): Promise<ToolResult> | ToolResult
}
