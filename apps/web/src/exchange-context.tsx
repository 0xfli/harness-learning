/**
 * How the composer reaches the harness: through context, the same way the
 * conversation reaches the feed.
 *
 * Separate from the feed context on purpose. Reading the log and writing to it
 * are different capabilities with different failure modes, and a component
 * that only renders the conversation should not be handed a way to append to
 * it.
 *
 * @module
 */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { StartExchange } from './exchange-client.ts'

const ExchangeContext = createContext<StartExchange | undefined>(undefined)

/** Props for {@link ExchangeProvider}. */
export interface ExchangeProviderProps {
  /** The one way this tree may say something to the model. */
  readonly start: StartExchange
  readonly children: ReactNode
}

/**
 * Make one exchange client available to a tree.
 *
 * @param props - the client and the tree that uses it.
 * @returns the provider element.
 */
export function ExchangeProvider({ start, children }: ExchangeProviderProps): ReactNode {
  return <ExchangeContext value={start}>{children}</ExchangeContext>
}

/**
 * The way this tree starts an exchange.
 *
 * @returns the client.
 * @throws when called outside an {@link ExchangeProvider} — a composer with
 *   nowhere to send is a composer that would silently swallow what was typed.
 */
export function useStartExchange(): StartExchange {
  const start = useContext(ExchangeContext)
  if (start === undefined) {
    throw new Error('useStartExchange must be called inside an ExchangeProvider')
  }
  return start
}
