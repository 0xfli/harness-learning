/**
 * The request, as text.
 *
 * The right column does not describe what the model is sent — it shows it, in
 * the bytes it goes out in. That constraint is what makes the column worth
 * having: a prettier rendering could be wrong and look fine, whereas a
 * serialisation can be compared to what the provider actually received, and
 * `test/model-view.test.ts` compares it.
 *
 * So the whole module is one identity, kept true by construction:
 *
 * ```ts
 * blocks.map((block) => block.json).join(',\n') // wrapped in [ ]
 * === JSON.stringify(messages, null, 2)
 * ```
 *
 * The split exists only so each message can be painted in its own colour.
 * Nothing is inserted, nothing is elided, and the concatenation of what is on
 * screen is the request.
 *
 * @module
 */

import type { MessageRole, ModelMessage } from '@harness/exchange'

/** What `JSON.stringify(value, null, 2)` indents a nested object by. */
const INDENT = '  '

/** One message, ready to be painted. */
export interface MessageBlock {
  /** Position in the request. The React key, and a stable one: a projection
   * only ever grows a message at the end or replaces the lot. */
  readonly index: number
  /** Who is speaking, so the column can carry the family colours across. */
  readonly role: MessageRole
  /** This message's JSON, indented to its place inside the array. */
  readonly json: string
}

/**
 * Cut the request into one block per message.
 *
 * @param messages - the derived request.
 * @returns the blocks, in request order. Frozen; a projection is recomputed
 *   rather than edited.
 */
export function modelViewBlocks(messages: readonly ModelMessage[]): readonly MessageBlock[] {
  return Object.freeze(
    messages.map((message, index) =>
      Object.freeze({
        index,
        role: message.role,
        json: indent(JSON.stringify(message, null, 2)),
      }),
    ),
  )
}

/**
 * The request as the provider is handed it.
 *
 * Equal to `JSON.stringify(messages, null, 2)`, character for character — and
 * assembled from the blocks rather than beside them, so the text on screen and
 * the text quoted here cannot drift.
 *
 * @param messages - the derived request.
 * @returns pretty-printed JSON.
 */
export function modelViewJson(messages: readonly ModelMessage[]): string {
  const blocks = modelViewBlocks(messages)
  if (blocks.length === 0) return '[]'
  return `[\n${blocks.map((block) => block.json).join(',\n')}\n]`
}

/**
 * Push every line of a value one level in.
 *
 * Safe on a JSON string because `JSON.stringify` escapes the newlines inside
 * string values, so the only line breaks left are the ones it made itself.
 *
 * @param json - a serialised message.
 * @returns the same JSON, indented as an array element.
 */
function indent(json: string): string {
  return json
    .split('\n')
    .map((line) => INDENT + line)
    .join('\n')
}
