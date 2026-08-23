/**
 * Sessions that live for exactly as long as the process does.
 *
 * The store the harness falls back to when nobody said where to keep
 * anything — a session recorded here is real while it runs and gone when the
 * process exits, which is the honest behaviour for a server started with no
 * journal directory and the only behaviour a test should have.
 *
 * It exists to keep {@link SessionStore} the only thing the server knows
 * about. A server that reached for a filesystem when a store was missing would
 * be a server with two ways of finding a log.
 *
 * @module
 */

import { SessionLog, newSessionId, summariseEvents } from '@harness/session'
import type { OpenSession, SessionStore, SessionSummary } from '@harness/session'

/**
 * Build a store that keeps its sessions in memory.
 *
 * @returns the store. Every session in it is forgotten on exit.
 */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, OpenSession>()

  const summarise = (id: string): SessionSummary | undefined => {
    const session = sessions.get(id)
    return session === undefined ? undefined : summariseEvents(id, session.log.events)
  }

  const store: SessionStore = {
    list(): readonly SessionSummary[] {
      return Object.freeze(
        [...sessions.keys()]
          .map((id) => summariseEvents(id, sessions.get(id)?.log.events ?? []))
          .toSorted((left, right) => right.id.localeCompare(left.id)),
      )
    },

    has: (id) => sessions.has(id),

    summarise,

    open(id: string): OpenSession {
      const held = sessions.get(id)
      if (held !== undefined) return held

      const session: OpenSession = {
        id,
        log: new SessionLog(),
        close(): void {
          if (sessions.get(id) === session) sessions.delete(id)
        },
      }
      sessions.set(id, session)
      return session
    },

    create(): OpenSession {
      const base = newSessionId()
      let id = base
      for (let n = 2; sessions.has(id); n += 1) id = `${base}-${n}`
      return store.open(id)
    },

    close(): void {
      sessions.clear()
    },
  }

  return store
}
