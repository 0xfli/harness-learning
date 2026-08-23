/**
 * The middle column: what the human sees.
 *
 * Two React 19 hooks and no state of its own. `useOptimistic` shows the turn
 * the log has not confirmed yet; `useActionState` owns "sending" and "that
 * failed", so neither is a flag somebody has to remember to clear. What is
 * missing is the point of this step: nothing here appends a character to a
 * bubble, and nothing here holds a copy of the conversation. Both are
 * recomputed from the event array on every render.
 *
 * @module
 */

import { useActionState, useMemo, useOptimistic } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { deriveConversation, optimisticTurn, withOptimistic } from '../conversation.ts'
import type { MessageTurn, ToolTurn, Turn } from '../conversation.ts'
import { newMessageId } from '../exchange-client.ts'
import type { OutgoingMessage } from '../exchange-client.ts'
import { useStartExchange } from '../exchange-context.tsx'
import { useSessionEvents } from '../use-session.ts'
import { useTailFollow } from '../use-tail-follow.ts'
import { Panel, PanelPlaceholder } from './panel.tsx'

/** What the composer has to say for itself after an attempt. */
interface ComposerState {
  /** Why the last attempt failed, when it did. */
  readonly error: string | undefined
  /** What was typed, kept only so a failed attempt is not retyped. */
  readonly text: string
}

const READY: ComposerState = { error: undefined, text: '' }

/**
 * The conversation, and the box that adds to it.
 *
 * @returns the column element.
 */
export function ConversationPanel(): ReactNode {
  const events = useSessionEvents()
  const startExchange = useStartExchange()

  // Keyed on the snapshot's identity, which the feed client guarantees changes
  // only when the log actually grew (ADR-0002). So a reply of a hundred deltas
  // folds a hundred times — once per new fact — rather than once per render.
  const turns = useMemo(() => deriveConversation(events), [events])

  // The optimistic value is the whole turn list, not a flag beside it: the
  // reducer runs again against the freshly derived turns on every render, so
  // the moment `user/message` lands the pending copy stops being added. That
  // is the entire reconciliation.
  const [visible, sayOptimistically] = useOptimistic(
    turns,
    (base: readonly Turn[], message: OutgoingMessage) =>
      withOptimistic(base, optimisticTurn(message.id, message.text)),
  )

  const [composer, submit, sending] = useActionState(
    async (_previous: ComposerState, form: FormData): Promise<ComposerState> => {
      const text = String(form.get('text') ?? '').trim()
      if (text.length === 0) return READY

      // The client names the exchange, so the optimistic turn and the event
      // that confirms it are the same turn. See `docs/adr/0005`.
      const message = { id: newMessageId(), text }
      sayOptimistically(message)
      try {
        await startExchange(message)
        return READY
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), text }
      }
    },
    READY,
  )

  // Anything that grew is a reason to follow: a new turn, and every delta
  // inside the one at the bottom.
  const tail = useTailFollow(events.length + visible.length)

  return (
    <Panel
      title="Conversation"
      note={`${visible.length} ${visible.length === 1 ? 'turn' : 'turns'}`}
      bodyRef={tail.ref}
      onBodyScroll={tail.onScroll}
      footer={<Composer action={submit} sending={sending} state={composer} />}
    >
      {visible.length === 0 ? (
        <PanelPlaceholder>
          nothing has been said yet. What appears here is derived from the log — the same events the
          left column is showing, read as a conversation.
        </PanelPlaceholder>
      ) : (
        <ol className="turn-list">
          {visible.map((turn) => (
            <TurnBubble key={turn.key} turn={turn} />
          ))}
        </ol>
      )}
    </Panel>
  )
}

interface TurnBubbleProps {
  readonly turn: Turn
}

function TurnBubble({ turn }: TurnBubbleProps): ReactNode {
  return turn.role === 'tool' ? <ToolCard turn={turn} /> : <MessageBubble turn={turn} />
}

function MessageBubble({ turn }: { readonly turn: MessageTurn }): ReactNode {
  return (
    <li className="turn" data-role={turn.role} data-state={turn.state} data-message-id={turn.id}>
      <span className="turn-role">{turn.role}</span>
      <p className="turn-text">{turn.text}</p>
      {turn.error === undefined ? null : <p className="turn-error">{turn.error}</p>}
    </li>
  )
}

/**
 * What the harness did between two things the model said.
 *
 * The pending state is rendered from the same field as every other state and
 * needs no timer, no spinner state and no cleanup: a card is pending exactly
 * while the log has a `tool/call` and no `tool/result` for it. When the result
 * is appended the fold runs again and the card is finished. Nothing here is
 * told; it is all read.
 *
 * @param props - the tool turn to draw.
 * @returns the card element.
 */
function ToolCard({ turn }: { readonly turn: ToolTurn }): ReactNode {
  const pending = turn.state === 'pending'
  return (
    <li
      className="turn turn-tool"
      data-role="tool"
      data-state={turn.state}
      data-message-id={turn.id}
      data-call-id={turn.callId}
    >
      <span className="turn-role">{turn.name}</span>
      <pre className="tool-arguments">{turn.arguments}</pre>
      {pending ? (
        <p className="tool-pending" aria-live="polite">
          running…
        </p>
      ) : (
        <pre className="tool-result" data-error={turn.isError}>
          {turn.result}
        </pre>
      )}
    </li>
  )
}

interface ComposerProps {
  readonly action: (form: FormData) => void
  readonly sending: boolean
  readonly state: ComposerState
}

/**
 * The box at the bottom.
 *
 * The form is uncontrolled: the browser holds what is being typed, which is
 * why a keystroke re-renders nothing at all. `sending` and `state.error` both
 * come from the action — there is no `isSubmitting` to set, and no `catch`
 * that has to remember to unset it.
 *
 * @param props - the form action and what it last reported.
 * @returns the composer element.
 */
function Composer({ action, sending, state }: ComposerProps): ReactNode {
  return (
    <form className="composer" action={action}>
      <label className="composer-label" htmlFor="composer-text">
        Message
      </label>
      <textarea
        id="composer-text"
        name="text"
        className="composer-input"
        rows={2}
        // Restored only when the last attempt failed; React resets an
        // uncontrolled form once its action settles, and losing what somebody
        // typed because the provider was down is not an acceptable way to
        // report that the provider was down.
        defaultValue={state.text}
        placeholder="say something to the model"
        disabled={sending}
        onKeyDown={submitOnEnter}
      />
      <button type="submit" className="composer-send" disabled={sending}>
        {sending ? 'replying…' : 'send'}
      </button>
      {state.error === undefined ? null : (
        <p className="composer-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  )
}

/** Enter sends, shift-enter is a newline — the convention every chat box uses. */
function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
  event.preventDefault()
  event.currentTarget.form?.requestSubmit()
}
