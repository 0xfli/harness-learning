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

import type { SessionEvent, SessionLog } from '@harness/session'
import type { MessageRole, ModelMessage } from '@harness/llm'
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
 * - `assistant/reasoning` — the sharpest case, and the reason this comment is
 *   worth reading. Reasoning is the most interesting thing the model produced
 *   and it is logged in full, delta by delta, for the human. It still goes
 *   nowhere near the next request: it is not something anybody *said*, and
 *   DeepSeek documents that outside tool use it may be left out of the history
 *   with no error. The first event type that is deliberately visible to one
 *   reader and invisible to another.
 *
 *   This entry has an expiry date. The moment tool calls arrive, the same
 *   provider requires the opposite: "if the request carries the `tools`
 *   parameter, the intermediate assistant's `reasoning_content` must
 *   participate in the context concatenation and must be passed back to the
 *   API in all subsequent user interaction turns — even if the model did not
 *   perform a tool call in that turn. Otherwise the API returns a 400 error."
 *   Anthropic is stricter still and wants its `thinking` block returned with
 *   the signature it was issued with. So whoever adds tool calling must come
 *   back to this table and give the rule a condition, and the symptom of
 *   forgetting is a 400 on the second turn of any conversation that used a
 *   tool — a long way from here.
 *   @see https://api-docs.deepseek.com/guides/thinking_mode/
 * - `assistant/usage` — what a reply cost is a fact about the request, not a
 *   thing anybody said.
 * - `error/stream` — an exchange that never produced an `assistant/message`
 *   never produced a reply the log calls finished. The human saw the deltas
 *   that did arrive and the model will not; that divergence is deliberate,
 *   visible in the inspector, and argued in ADR-0006.
 */
export const MESSAGE_RULES: Readonly<Record<string, MessageRule>> = Object.freeze({
  [EXCHANGE_EVENT_TYPES.userMessage]: (event) => said('user', event),
  [EXCHANGE_EVENT_TYPES.assistantMessage]: (event) => said('assistant', event),
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
function said(role: MessageRole, event: SessionEvent): ModelMessage | undefined {
  const text = event.data['text']
  if (typeof text !== 'string') return undefined
  return Object.freeze({ role, content: text })
}
