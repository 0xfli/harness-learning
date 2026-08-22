/**
 * The write half of the client: saying something to the model.
 *
 * The feed client is deliberately read-only — it replicates the log and never
 * edits it — so this is a separate, much smaller thing: one POST, and the
 * server appends the facts that come back down the feed. The page never
 * inserts an event into its own replica, which is what keeps "the log is the
 * source of truth" true on this side of the wire too.
 *
 * @module
 */

import type { MessageId } from '@harness/exchange'

/** What the human said, and the name the client gave the exchange. */
export interface OutgoingMessage {
  /**
   * The message id every event of this exchange will carry.
   *
   * Named by the client rather than the server, so the optimistic turn and the
   * `user/message` event that lands a moment later are the same turn rather
   * than two that look alike. See `docs/adr/0005`.
   */
  readonly id: MessageId
  readonly text: string
}

/**
 * Start one exchange.
 *
 * Resolves when the reply has been recorded in full — the request is open for
 * as long as the model is talking. That is why the form's own `pending` is a
 * usable "the model is still replying" signal without anybody tracking one.
 */
export type StartExchange = (message: OutgoingMessage) => Promise<void>

/** How to reach the harness. */
export interface ExchangeClientOptions {
  /** Where to post. Relative by default, so it follows the serving origin. */
  readonly url?: string
}

const DEFAULT_URL = '/messages'

/**
 * Build the client that starts exchanges.
 *
 * @param options - where to post.
 * @returns a function that sends one message and resolves when the reply is
 *   recorded.
 * @throws when the server refuses the message or the request never arrives.
 *   The message is meant to be read by a human, because it ends up in the
 *   composer.
 */
export function createExchangeClient(options: ExchangeClientOptions = {}): StartExchange {
  const url = options.url ?? DEFAULT_URL

  return async ({ id, text }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text }),
    })
    if (!response.ok) throw new Error(await failureMessage(response))
  }
}

/**
 * A fresh name for an exchange.
 *
 * @returns a message id no other exchange will use.
 */
export function newMessageId(): MessageId {
  return globalThis.crypto.randomUUID()
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0) return body.error
  } catch {
    // A failure whose body is not JSON is still a failure; the status is the
    // only thing worth reporting, and losing it to a parse error would be
    // worse than a vague message.
  }
  return `the harness answered ${response.status}`
}
