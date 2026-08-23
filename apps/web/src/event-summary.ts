/**
 * One event, summarised to the part that differs.
 *
 * The stream used to print `JSON.stringify(event.data)` and let CSS clip it.
 * That reads fine on paper and is useless on screen, because every payload
 * begins with the message id — the same thirty-six characters on every row of
 * an exchange. A clipped line therefore showed the reader the one field that
 * cannot tell two rows apart, and hid every field that can.
 *
 * So a row leads with what is different about it: the delta, the arguments,
 * the answer. The id is dropped, not because it does not matter but because it
 * is a *grouping* key — something to filter by, never something to read twenty
 * times down a column. It is still in the log, still on the row as
 * `data-message-id`, and still in the payload a row expands to.
 *
 * The table is the whole answer to "what does a row show?", the same way
 * `MESSAGE_RULES` is the whole answer to "what does the model see?". A type
 * with no entry is not an error — it falls back to its payload minus the id,
 * so a new event type is legible the day it is invented and gets a rule only
 * when it deserves one.
 *
 * @module
 */

import type { JsonObject, JsonValue, SessionEvent } from '@harness/session'

/** How one event type says what happened, in one line. */
type Summary = (data: JsonObject) => string

/**
 * The rules, keyed by event type.
 *
 * Ordered as the log writes them, because that is the order a reader meets
 * them in and a table that reads like the thing it describes needs no map.
 */
const SUMMARIES: Readonly<Record<string, Summary>> = {
  'demo/hello': (data) => text(data['message']),

  'user/message': (data) => text(data['text']),

  // Quoted, and only these: a delta arrives mid-word and mid-sentence, so the
  // leading space in `" there"` is the difference between two rows that would
  // otherwise look identical. Quoting is what makes whitespace visible.
  'assistant/reasoning': (data) => quoted(data['text']),
  'assistant/chunk': (data) => quoted(data['text']),

  'assistant/usage': (data) => `${count(data['input'])} in · ${count(data['output'])} out`,

  'assistant/message': (data) => {
    const calls = toolCallsIn(data['toolCalls'])
    const said = text(data['text'])
    const reason = text(data['reason'])
    if (calls.length > 0) return `${reason} · ${calls.map(callSignature).join(', ')}`
    return said.length > 0 ? `${reason} · ${said}` : reason
  },

  'tool/call': (data) => `${text(data['name'])}(${text(data['arguments'])})`,

  // The arrow is doing real work: it is the shape of the pair, and a reader
  // scanning for an unanswered call is looking for a `tool/call` with no arrow
  // under it.
  'tool/result': (data) =>
    `${text(data['name'])} → ${data['isError'] === true ? '✗ ' : ''}${text(data['content'])}`,

  'error/stream': (data) => text(data['message']),
  'error/steps': (data) => text(data['message']),
}

/**
 * What a row says about an event.
 *
 * @param event - the event to summarise.
 * @returns one line, unclipped — the column decides how much of it fits.
 */
export function summariseEvent(event: SessionEvent): string {
  const rule = SUMMARIES[event.type]
  const summary = rule === undefined ? '' : collapse(rule(event.data))
  // A rule knows the fields its type usually carries, and an event of that
  // type carrying different ones would otherwise render as a blank line — the
  // payload silently unreachable, which is the bug this module exists to fix.
  // So a rule with nothing to say defers to the payload rather than to
  // nothing.
  return summary === '' ? collapse(fallback(event.data)) : summary
}

/**
 * The exchange a row belongs to, when it belongs to one.
 *
 * Dropped from the summary and kept here instead, so the id is available to
 * anything that wants to group or filter without being printed on every line.
 *
 * @param event - the event.
 * @returns the message id, or `undefined`.
 */
export function messageIdOf(event: SessionEvent): string | undefined {
  const id = event.data['id']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The payload as a reader would want to inspect it.
 *
 * Everything, including the id — the summary is an edit, this is the record,
 * and the two are one click apart so neither has to compromise for the other.
 *
 * @param event - the event.
 * @returns pretty-printed JSON, or an empty string for an empty payload.
 */
export function payloadOf(event: SessionEvent): string {
  return Object.keys(event.data).length === 0 ? '' : JSON.stringify(event.data, null, 2)
}

/** An unknown type's payload, minus the field every row shares. */
function fallback(data: JsonObject): string {
  const { id: _id, ...rest } = data
  return Object.keys(rest).length === 0 ? '' : JSON.stringify(rest)
}

/** `name({"path":"."})`, the way it reads in a `tool/call` row. */
function callSignature(call: JsonObject): string {
  return `${text(call['name'])}(${text(call['arguments'])})`
}

/** The `toolCalls` of an assistant message, if it has any. */
function toolCallsIn(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.filter((call): call is JsonObject => typeof call === 'object' && call !== null)
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function count(value: JsonValue | undefined): string {
  return typeof value === 'number' ? String(value) : '?'
}

function quoted(value: JsonValue | undefined): string {
  return JSON.stringify(text(value))
}

/**
 * One line, whatever the payload had in it.
 *
 * A row is `white-space: nowrap` and a newline inside it would end the visible
 * line early, leaving the rest silently unreachable — which is the bug this
 * module exists to fix, arriving by another route.
 */
function collapse(summary: string): string {
  return summary.replaceAll(/\s*\n\s*/g, ' ⏎ ').trim()
}
