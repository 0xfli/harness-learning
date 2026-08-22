/**
 * The conversation, folded out of the log.
 *
 * This is the module the step is about, so it is worth naming what is *not*
 * here: there is no code that appends a character to a bubble. A delta does
 * not arrive at a rendered paragraph and extend it — it arrives at the log,
 * the log hands out a new array, and this function runs again over all of it.
 * The typewriter is an emergent property of recomputing a pure projection
 * against a growing array of facts, not an effect anybody wrote.
 *
 * Which is also why reloading reproduces the conversation exactly. Replaying
 * the log calls this with the same events in the same order, and a pure
 * function of the same input is the same output. There is nothing else to
 * restore, because there was never anything else.
 *
 * @module
 */

import { EXCHANGE_EVENT_TYPES } from '@harness/exchange'
import type { MessageId } from '@harness/exchange'
import type { SessionEvent } from '@harness/session'

/** Who is speaking. */
export type TurnRole = 'user' | 'assistant'

/**
 * How far along a turn is.
 *
 * - `pending` — said, but not yet in the log. Only ever an optimistic turn.
 * - `streaming` — chunks have arrived and `assistant/message` has not.
 * - `complete` — the log says this turn is finished.
 * - `failed` — the stream stopped early. Whatever arrived first still shows,
 *   because it is what actually happened.
 */
export type TurnState = 'pending' | 'streaming' | 'complete' | 'failed'

/** One bubble in the middle column. */
export interface Turn {
  /**
   * Identity across renders, and the React key.
   *
   * A message id names an *exchange*, so the human's turn and the model's
   * reply share one — the role is what tells the two bubbles apart.
   */
  readonly key: string
  /** The exchange this turn belongs to. */
  readonly id: MessageId
  readonly role: TurnRole
  /** For an assistant turn: every delta so far, concatenated. */
  readonly text: string
  readonly state: TurnState
  /** Why the stream stopped, when it stopped early. */
  readonly error: string | undefined
}

/** A turn under construction. The frozen {@link Turn} is made from it. */
interface Draft {
  key: string
  id: MessageId
  role: TurnRole
  text: string
  state: TurnState
  error: string | undefined
}

/**
 * Fold the log into the bubbles a human should see.
 *
 * `assistant/chunk` events are grouped by message id and concatenated in log
 * order, which is delta order — so a reply that is still streaming is simply a
 * reply whose fold has not finished yet. `assistant/message` replaces that
 * accumulation with the assembled text the log calls authoritative; the two
 * agree byte for byte, and preferring the summary means a reader never has to
 * trust the client's own concatenation.
 *
 * `assistant/usage` is deliberately ignored: what a reply cost is a fact about
 * the request, and the middle column is what the human sees.
 *
 * @param events - the replica, or any slice of a log.
 * @returns the conversation, oldest turn first. Frozen, because a projection
 *   is recomputed rather than edited.
 */
export function deriveConversation(events: readonly SessionEvent[]): readonly Turn[] {
  const drafts: Draft[] = []
  const byKey = new Map<string, Draft>()

  const open = (role: TurnRole, id: MessageId): Draft => {
    const key = turnKey(role, id)
    const held = byKey.get(key)
    if (held !== undefined) return held
    const draft: Draft = { key, id, role, text: '', state: 'streaming', error: undefined }
    byKey.set(key, draft)
    drafts.push(draft)
    return draft
  }

  for (const event of events) {
    const id = event.data['id']
    if (typeof id !== 'string' || id.length === 0) continue
    const text = event.data['text']

    switch (event.type) {
      case EXCHANGE_EVENT_TYPES.userMessage: {
        if (typeof text !== 'string') break
        const turn = open('user', id)
        turn.text = text
        turn.state = 'complete'
        break
      }

      case EXCHANGE_EVENT_TYPES.assistantChunk: {
        if (typeof text !== 'string') break
        const turn = open('assistant', id)
        turn.text += text
        break
      }

      case EXCHANGE_EVENT_TYPES.assistantMessage: {
        if (typeof text !== 'string') break
        const turn = open('assistant', id)
        turn.text = text
        turn.state = 'complete'
        break
      }

      case EXCHANGE_EVENT_TYPES.streamError: {
        const turn = open('assistant', id)
        turn.state = 'failed'
        turn.error =
          typeof event.data['message'] === 'string' ? event.data['message'] : 'the stream stopped'
        break
      }

      default:
        // Every other event belongs to one of the other two columns. A type
        // this projection does not know is not an error; it is somebody else's
        // fact.
        break
    }
  }

  return Object.freeze(drafts.map((draft) => Object.freeze({ ...draft })))
}

/**
 * The turn a human has said but the log has not confirmed yet.
 *
 * It carries the id the client will ask the server to use, which is what makes
 * {@link withOptimistic} exact rather than a guess.
 *
 * @param id - the message id sent with the request.
 * @param text - what was typed.
 * @returns a pending user turn.
 */
export function optimisticTurn(id: MessageId, text: string): Turn {
  return Object.freeze({
    key: turnKey('user', id),
    id,
    role: 'user' as const,
    text,
    state: 'pending' as const,
    error: undefined,
  })
}

/**
 * Show a turn the log has not caught up with, and stop the moment it has.
 *
 * The whole reconciliation is one identity check, and it is exact because the
 * client named the exchange before sending it: when `user/message` arrives it
 * carries the same id, derives to the same key, and the optimistic copy is
 * dropped rather than rendered twice. Nothing is compared by text, nothing is
 * timed, and nothing is deleted — the pending turn simply stops being added.
 *
 * @param turns - the conversation as derived from the log.
 * @param pending - the optimistic turn, or `undefined` when nothing is in
 *   flight.
 * @returns the turns to render.
 */
export function withOptimistic(turns: readonly Turn[], pending: Turn | undefined): readonly Turn[] {
  if (pending === undefined) return turns
  return turns.some((turn) => turn.key === pending.key) ? turns : [...turns, pending]
}

function turnKey(role: TurnRole, id: MessageId): string {
  return `${role}:${id}`
}
