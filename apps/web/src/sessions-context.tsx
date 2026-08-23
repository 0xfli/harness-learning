/**
 * How the picker reaches the shelf: through context, like everything else the
 * page did not build itself.
 *
 * A third context rather than more methods on the feed's, for the reason the
 * exchange client has its own: reading the log, adding to it, and choosing
 * which one to read are three capabilities, and a component should be handed
 * only the one it uses.
 *
 * @module
 */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Sessions } from './sessions-client.ts'

const SessionsContext = createContext<Sessions | undefined>(undefined)

/** Props for {@link SessionsProvider}. */
export interface SessionsProviderProps {
  /** The shelf this tree may browse. */
  readonly sessions: Sessions
  readonly children: ReactNode
}

/**
 * Make one shelf available to a tree.
 *
 * @param props - the shelf and the tree that browses it.
 * @returns the provider element.
 */
export function SessionsProvider({ sessions, children }: SessionsProviderProps): ReactNode {
  return <SessionsContext value={sessions}>{children}</SessionsContext>
}

/**
 * The shelf this tree browses.
 *
 * @returns the client.
 * @throws when called outside a {@link SessionsProvider} — a picker with no
 *   shelf would offer a list of nothing and blame the server for it.
 */
export function useSessions(): Sessions {
  const sessions = useContext(SessionsContext)
  if (sessions === undefined) {
    throw new Error('useSessions must be called inside a SessionsProvider')
  }
  return sessions
}
