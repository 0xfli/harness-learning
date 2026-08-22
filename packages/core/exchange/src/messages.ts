/**
 * What the model is shown, read back out of the log.
 *
 * The request history is not a variable. It is recomputed from the events
 * immediately before every request, which is why appending `user/message`
 * *before* streaming is not merely tidy — it is how the message reaches the
 * model at all.
 *
 * This is the smallest projection that works: two event types, text only.
 * Step #5 replaces it with a real `deriveMessages` that folds tool results and
 * content blocks as well, and puts the result on screen next to the
 * conversation so the two can be compared. The shape of the rule is already
 * here: derive, never maintain.
 *
 * @module
 */

import type { SessionEvent, SessionLog } from '@harness/session'
import type { ModelMessage } from '@harness/llm'
import { EXCHANGE_EVENT_TYPES } from './types.ts'

/**
 * Fold the log into the messages a provider should be sent.
 *
 * `assistant/chunk` events are deliberately ignored: a delta is a fact about
 * the *process*, and the assembled `assistant/message` is the fact about the
 * *result*. Sending both would show the model everything twice.
 *
 * @param log - the session log, or any array of events from one.
 * @returns the conversation so far, oldest first.
 */
export function modelMessages(log: SessionLog | readonly SessionEvent[]): readonly ModelMessage[] {
  const events = Array.isArray(log) ? log : (log as SessionLog).events
  const messages: ModelMessage[] = []

  for (const event of events as readonly SessionEvent[]) {
    switch (event.type) {
      case EXCHANGE_EVENT_TYPES.userMessage: {
        const text = event.data.text
        if (typeof text === 'string') messages.push({ role: 'user', content: text })
        break
      }
      case EXCHANGE_EVENT_TYPES.assistantMessage: {
        const text = event.data.text
        if (typeof text === 'string') messages.push({ role: 'assistant', content: text })
        break
      }
      default:
        break
    }
  }

  return messages
}
