/**
 * What the model is shown, folded out of the log.
 *
 * The request history is not a variable. There is no `messages` array that
 * something appends to as the conversation grows, because the moment there is
 * one there are two records of the same conversation and only one of them is
 * the log. The two agree right until a branch updates one and forgets the
 * other — the tool-result path is the classic — and by then the model is being
 * shown a conversation that never happened, which is the worst class of bug
 * this codebase can have: everything on screen still looks right.
 *
 * So the history is recomputed from the events immediately before every
 * request, which is also why `recordExchange` appends `user/message` *before*
 * streaming rather than merely tidily: appending is how the message reaches
 * the model at all. And because the browser folds the same events with this
 * same function, the right-hand column of the inspector is not a rendering of
 * the request — it is the request, byte for byte. See
 * `docs/adr/0006-the-model-view-is-derived.md`.
 *
 * @module
 */

import type { JsonValue, SessionEvent, SessionLog } from '@harness/session'
import type { ModelMessage, ToolCall } from '@harness/llm'
import { EXCHANGE_EVENT_TYPES } from './types.ts'

/**
 * How one event type contributes to the request.
 *
 * `undefined` means "this event says nothing to the model": a payload without
 * text to send, or a fact that belongs to a different reader.
 */
export type MessageRule = (event: SessionEvent) => ModelMessage | undefined

/**
 * Every event type the model's view is made of.
 *
 * A table rather than a `switch`, because it is the answer to "what would I
 * change to show the model something new?". Adding a type is adding an entry:
 * no caller changes, no second place to keep in step, and one obvious place to
 * look when the column disagrees with what somebody expected.
 *
 * The types that are *absent* are the interesting half:
 *
 * - `assistant/chunk` — a delta is a fact about the process; the assembled
 *   `assistant/message` is the fact about the result. Sending both would show
 *   the model everything twice.
 * - `assistant/reasoning` — logged in full, delta by delta, for the human, and
 *   never replayed *from here*. What gets replayed is the assembled
 *   `reasoning` on the `assistant/message`, and only when the request that
 *   produced it carried tools. The condition lives at the recorder rather than
 *   in this table for a reason worth knowing: this projection runs in the
 *   browser too, over a replica, and the browser has no idea what was on the
 *   table when a request went out three days ago. The recorder does, so it
 *   decides once and writes the answer down — which is the same rule as
 *   everywhere else here, that a projection reads facts rather than
 *   reconstructing intent.
 *
 *   The condition itself is DeepSeek's: "if the request carries the `tools`
 *   parameter, the intermediate assistant's `reasoning_content` must
 *   participate in the context concatenation and must be passed back to the
 *   API in all subsequent user interaction turns — even if the model did not
 *   perform a tool call in that turn. Otherwise the API returns a 400 error."
 *   Outside tool use the same field may be omitted with no error, and is.
 *   Anthropic is stricter still and wants its `thinking` block returned with
 *   the signature it was issued with; when an Anthropic adapter arrives, the
 *   signature is one more thing `assistant/message` will have to carry.
 *   @see https://api-docs.deepseek.com/guides/thinking_mode/
 * - `assistant/usage` — what a reply cost is a fact about the request, not a
 *   thing anybody said.
 * - `tool/call` — the calls are already on the `assistant/message` that asked
 *   for them, which is where a provider expects to find them: one assistant
 *   message carrying an array, not one message per call. The event exists for
 *   the other readers — it is what a `tool/result` pairs with, and what the
 *   inspector draws a pending card from. Giving it a rule would show the model
 *   its own request twice.
 * - `error/stream` — a step that never produced an `assistant/message` never
 *   produced a reply the log calls finished. The human saw the deltas that did
 *   arrive and the model will not; that divergence is deliberate, visible in
 *   the inspector, and argued in ADR-0006.
 * - `error/steps` — the loop's own bookkeeping. That the harness stopped
 *   asking is not something anybody said to the model.
 */
export const MESSAGE_RULES: Readonly<Record<string, MessageRule>> = Object.freeze({
  [EXCHANGE_EVENT_TYPES.userMessage]: (event) => said('user', event),
  [EXCHANGE_EVENT_TYPES.assistantMessage]: (event) => replied(event),
  [EXCHANGE_EVENT_TYPES.toolResult]: (event) => answered(event),
})

/**
 * Fold the log into the messages a provider should be sent.
 *
 * Pure, and total: an event type with no rule contributes nothing rather than
 * throwing, because a log full of facts this projection has never heard of is
 * the normal case — they belong to the other two columns.
 *
 * @param log - the session log, or any array of events from one. A replica in
 *   a browser is the second case, and gives the same answer for the same
 *   prefix of the same log.
 * @returns the conversation so far, oldest first. Frozen, because a projection
 *   is recomputed rather than edited.
 */
export function deriveMessages(log: SessionLog | readonly SessionEvent[]): readonly ModelMessage[] {
  const events: readonly SessionEvent[] = Array.isArray(log) ? log : (log as SessionLog).events
  const messages: ModelMessage[] = []

  for (const event of events) {
    const message = MESSAGE_RULES[event.type]?.(event)
    if (message !== undefined) messages.push(message)
  }

  return Object.freeze(messages)
}

/**
 * One message, from an event that carries text.
 *
 * Key order is part of the contract. `JSON.stringify` writes keys in insertion
 * order, and two sides serialising the same conversation have to produce the
 * same bytes for "byte-identical" to be a thing a test can check.
 *
 * @param role - who the event says was speaking.
 * @param event - the event to read `text` from.
 * @returns the message, or `undefined` when there is no text to send.
 */
function said(role: 'system' | 'user', event: SessionEvent): ModelMessage | undefined {
  const text = event.data['text']
  if (typeof text !== 'string') return undefined
  return Object.freeze({ role, content: text })
}

/**
 * What the model said, with whatever it asked to have run.
 *
 * `content` may be empty and the message still has to be sent: a model that
 * calls a tool without a word of preamble produced an assistant turn whose
 * whole substance is its `tool_calls`, and dropping it would leave the tool
 * results below answering nothing.
 *
 * @param event - an `assistant/message` event.
 * @returns the message, or `undefined` when the payload carries no text field.
 */
function replied(event: SessionEvent): ModelMessage | undefined {
  const text = event.data['text']
  if (typeof text !== 'string') return undefined

  const calls = toolCallsOf(event.data['toolCalls'])
  const reasoning = event.data['reasoning']

  return Object.freeze({
    role: 'assistant' as const,
    content: text,
    ...(calls.length === 0 ? {} : { toolCalls: calls }),
    // Written down by the recorder exactly when it is wanted, so this is a
    // pass-through rather than a decision. See `MESSAGE_RULES`.
    ...(typeof reasoning === 'string' && reasoning.length > 0 ? { reasoning } : {}),
  })
}

/**
 * What a tool said back, addressed to the call it answers.
 *
 * A failed tool derives exactly like a successful one. That is the point:
 * `isError` is for the human reading the inspector, and the model is told what
 * happened in the one place it reads — the content of the result. A provider
 * has no field for "this result is bad news", and inventing a shape for one
 * would mean the model never sees it.
 *
 * @param event - a `tool/result` event.
 * @returns the message, or `undefined` when the payload cannot address a call.
 */
function answered(event: SessionEvent): ModelMessage | undefined {
  const content = event.data['content']
  const callId = event.data['callId']
  if (typeof content !== 'string' || typeof callId !== 'string' || callId.length === 0) {
    return undefined
  }
  return Object.freeze({ role: 'tool' as const, content, toolCallId: callId })
}

/**
 * Read the calls off an `assistant/message` payload.
 *
 * Defensive because the payload is JSON from a log that may have been written
 * by an older version of this code, and a projection that throws on an
 * unfamiliar event is a session that cannot be opened at all.
 *
 * @param value - the `toolCalls` field, whatever it turned out to be.
 * @returns the calls that are well-formed, frozen.
 */
function toolCallsOf(value: JsonValue | undefined): readonly ToolCall[] {
  if (!Array.isArray(value)) return EMPTY_CALLS
  const calls: ToolCall[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { id, name, arguments: args } = entry as Record<string, JsonValue>
    if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') continue
    calls.push(Object.freeze({ id, name, arguments: args }))
  }
  return Object.freeze(calls)
}

const EMPTY_CALLS: readonly ToolCall[] = Object.freeze([])
