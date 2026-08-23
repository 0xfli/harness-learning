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
 * Tools arrive here as a second kind of turn. The card that shows a call is
 * not a widget with a lifecycle; it is `tool/call` folded with no `tool/result`
 * beside it yet. "Pending" is therefore not a state anybody sets and later
 * clears — it is the *absence* of a fact, and it ends when the fact lands. The
 * same gap that makes the log balance is the gap the human watches.
 *
 * @module
 */

import { EXCHANGE_EVENT_TYPES } from '@harness/exchange'
import type { MessageId } from '@harness/exchange'
import type { SessionEvent } from '@harness/session'

/** Who is speaking. `tool` is the harness reporting what it did. */
export type TurnRole = 'user' | 'assistant' | 'tool'

/**
 * How far along a turn is.
 *
 * - `pending` — said, but not yet in the log. An optimistic turn, or a tool
 *   call whose result has not been appended.
 * - `streaming` — chunks have arrived and `assistant/message` has not.
 * - `complete` — the log says this turn is finished.
 * - `failed` — the stream stopped early, or the tool reported a failure.
 *   Whatever arrived first still shows, because it is what actually happened.
 */
export type TurnState = 'pending' | 'streaming' | 'complete' | 'failed'

/** What every turn has, whoever is speaking. */
interface TurnBase {
  /**
   * Identity across renders, and the React key.
   *
   * A message id names an *exchange*, and an exchange can now contain several
   * assistant replies — so the key carries the step too. Without it, a model
   * that called a tool and then answered would fold both replies into one
   * bubble and the answer would overwrite the sentence that preceded it.
   */
  readonly key: string
  /** The exchange this turn belongs to. */
  readonly id: MessageId
  readonly state: TurnState
}

/** Something somebody said. */
export interface MessageTurn extends TurnBase {
  readonly role: 'user' | 'assistant'
  /** For an assistant turn: every delta so far, concatenated. */
  readonly text: string
  /** Why the stream stopped, when it stopped early. */
  readonly error: string | undefined
}

/** Something the harness did, and what came back. */
export interface ToolTurn extends TurnBase {
  readonly role: 'tool'
  /** The provider's call id — what pairs this card with its result. */
  readonly callId: string
  readonly name: string
  /** The arguments as the model wrote them. Not guaranteed to parse. */
  readonly arguments: string
  /** What the tool said. Empty for as long as the card is pending. */
  readonly result: string
  /** Whether that result is a failure. A failure is still a result. */
  readonly isError: boolean
}

/** One bubble or card in the middle column. */
export type Turn = MessageTurn | ToolTurn

type Draft =
  | { -readonly [K in keyof MessageTurn]: MessageTurn[K] }
  | {
      -readonly [K in keyof ToolTurn]: ToolTurn[K]
    }

/**
 * Fold the log into the bubbles a human should see.
 *
 * `assistant/chunk` events are grouped by message id *and step* and
 * concatenated in log order, which is delta order — so a reply that is still
 * streaming is simply a reply whose fold has not finished yet.
 * `assistant/message` replaces that accumulation with the assembled text the
 * log calls authoritative; the two agree byte for byte, and preferring the
 * summary means a reader never has to trust the client's own concatenation.
 *
 * `assistant/usage` is deliberately ignored: what a reply cost is a fact about
 * the request, and the middle column is what the human sees.
 *
 * An assistant reply that carried nothing but tool calls is dropped, because
 * an empty bubble above a tool card tells a human less than the card already
 * does. The event is still in the log and still in the left column; this
 * column is an edit of the log, not a copy of it.
 *
 * @param events - the replica, or any slice of a log.
 * @returns the conversation, oldest turn first. Frozen, because a projection
 *   is recomputed rather than edited.
 */
export function deriveConversation(events: readonly SessionEvent[]): readonly Turn[] {
  const drafts: Draft[] = []
  const byKey = new Map<string, Draft>()

  const said = (role: 'user' | 'assistant', id: MessageId, step: number): Draft => {
    const key = role === 'user' ? userKey(id) : assistantKey(id, step)
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
    const step = stepOf(event)

    switch (event.type) {
      case EXCHANGE_EVENT_TYPES.userMessage: {
        if (typeof text !== 'string') break
        const turn = said('user', id, step)
        if (turn.role === 'tool') break
        turn.text = text
        turn.state = 'complete'
        break
      }

      case EXCHANGE_EVENT_TYPES.assistantChunk: {
        if (typeof text !== 'string') break
        const turn = said('assistant', id, step)
        if (turn.role === 'tool') break
        turn.text += text
        break
      }

      case EXCHANGE_EVENT_TYPES.assistantMessage: {
        if (typeof text !== 'string') break
        const turn = said('assistant', id, step)
        if (turn.role === 'tool') break
        turn.text = text
        turn.state = 'complete'
        break
      }

      case EXCHANGE_EVENT_TYPES.toolCall: {
        const callId = event.data['callId']
        if (typeof callId !== 'string') break
        const key = toolKey(id, callId)
        if (byKey.has(key)) break
        // Opened `pending` and left that way. Nothing here schedules a change
        // of state; the `tool/result` event is the only thing that ends it.
        const draft: Draft = {
          key,
          id,
          role: 'tool',
          state: 'pending',
          callId,
          name: stringOf(event.data['name']),
          arguments: stringOf(event.data['arguments']),
          result: '',
          isError: false,
        }
        byKey.set(key, draft)
        drafts.push(draft)
        break
      }

      case EXCHANGE_EVENT_TYPES.toolResult: {
        const callId = event.data['callId']
        if (typeof callId !== 'string') break
        const turn = byKey.get(toolKey(id, callId))
        // A result without a call is not renderable — and, if the loop is
        // working, not possible. See `unbalanced-history.test.ts`.
        if (turn === undefined || turn.role !== 'tool') break
        turn.result = stringOf(event.data['content'])
        turn.isError = event.data['isError'] === true
        turn.state = turn.isError ? 'failed' : 'complete'
        break
      }

      case EXCHANGE_EVENT_TYPES.streamError: {
        const turn = said('assistant', id, step)
        if (turn.role === 'tool') break
        turn.state = 'failed'
        turn.error = messageOf(event.data['message'], 'the stream stopped')
        break
      }

      case EXCHANGE_EVENT_TYPES.stepLimit: {
        // The step named here is the one that never ran, so this opens a turn
        // rather than failing an existing one: the human should see where the
        // conversation was cut off, not a reply that looks like it broke.
        const turn = said('assistant', id, step)
        if (turn.role === 'tool') break
        turn.state = 'failed'
        turn.error = messageOf(event.data['message'], 'the step limit was reached')
        break
      }

      default:
        // Every other event belongs to one of the other two columns. A type
        // this projection does not know is not an error; it is somebody else's
        // fact.
        break
    }
  }

  return Object.freeze(drafts.filter(worthShowing).map((draft) => Object.freeze({ ...draft })))
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
    key: userKey(id),
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

/** An assistant reply of nothing but tool calls is the card's business. */
function worthShowing(draft: Draft): boolean {
  if (draft.role !== 'assistant') return true
  return draft.text.length > 0 || draft.state === 'failed'
}

/**
 * Which request a turn belongs to.
 *
 * Missing on events written before steps existed, and on `user/message`, which
 * precedes every request. Both mean step zero.
 */
function stepOf(event: SessionEvent): number {
  const step = event.data['step']
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : 0
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function userKey(id: MessageId): string {
  return `user:${id}`
}

function assistantKey(id: MessageId, step: number): string {
  return `assistant:${id}:${step}`
}

function toolKey(id: MessageId, callId: string): string {
  return `tool:${id}:${callId}`
}
