/**
 * The picker: which session the page is looking at, and how to look at another.
 *
 * The list is read once, when this mounts. It is not kept in sync, and it is
 * not held anywhere the panels can see — a session summary is a fold over a
 * log that is still growing, so the honest lifetime of this list is "one
 * glance", which is also exactly how long a menu is open.
 *
 * Choosing a session navigates. See {@link module:session-url} for why that is
 * a feature rather than a shortcut.
 *
 * @module
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@harness/session'
import { formatAge } from './format.ts'
import { sessionInSearch } from './session-url.ts'
import { useSessions } from './sessions-context.tsx'
import type { SessionCatalogue } from './sessions-client.ts'

/** What the picker knows about the shelf so far. */
type Shelf =
  | { readonly status: 'reading' }
  | { readonly status: 'read'; readonly catalogue: SessionCatalogue }
  | { readonly status: 'unreachable'; readonly why: string }

const SELECT_ID = 'session-picker-select'

/**
 * The session control in the header.
 *
 * @returns the picker element.
 */
export function SessionPicker(): ReactNode {
  const sessions = useSessions()
  const [shelf, setShelf] = useState<Shelf>({ status: 'reading' })
  const [starting, setStarting] = useState(false)

  // Read during render rather than held in state: nothing on this page changes
  // the query without leaving the page, so state would be a copy of something
  // that cannot go stale, and a copy that cannot go stale is a copy nobody
  // needs.
  const pinned = sessionInSearch(globalThis.location.search)

  useEffect(() => {
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      try {
        setShelf({ status: 'read', catalogue: await sessions.list({ signal: controller.signal }) })
      } catch (error) {
        // An abort is this component leaving, not a shelf that failed.
        if (!controller.signal.aborted) setShelf({ status: 'unreachable', why: reason(error) })
      }
    }
    void read()
    return () => {
      controller.abort()
    }
  }, [sessions])

  const startNew = (): void => {
    setStarting(true)
    const start = async (): Promise<void> => {
      try {
        await sessions.create()
        // The new session is the run's, so the page follows the run by not
        // naming one — which is also what keeps it following after a restart.
        sessions.open(undefined)
      } catch (error) {
        setStarting(false)
        setShelf({ status: 'unreachable', why: reason(error) })
      }
    }
    void start()
  }

  return (
    <div className="session-picker">
      <label className="session-picker-label" htmlFor={SELECT_ID}>
        session
      </label>
      {shelf.status === 'read' ? (
        <select
          id={SELECT_ID}
          className="session-select"
          value={pinned ?? shelf.catalogue.current}
          onChange={(event) => {
            const id = event.target.value
            // The run's own session is named by *not* naming it.
            sessions.open(id === shelf.catalogue.current ? undefined : id)
          }}
        >
          {unlisted(shelf.catalogue, pinned) && (
            <option value={pinned}>{`${pinned ?? ''} · not on the shelf`}</option>
          )}
          {shelf.catalogue.sessions.map((summary) => (
            <option key={summary.id} value={summary.id}>
              {label(summary, shelf.catalogue.current)}
            </option>
          ))}
        </select>
      ) : (
        <select id={SELECT_ID} className="session-select" disabled title={note(shelf)}>
          <option>{note(shelf)}</option>
        </select>
      )}
      <button
        type="button"
        className="session-new"
        onClick={startNew}
        disabled={starting}
        title="Start a session and look at it"
      >
        new
      </button>
    </div>
  )
}

/**
 * One line describing a session.
 *
 * What it was about first, because that is what somebody is looking for, and
 * when it last moved second, because that is how they narrow it down.
 *
 * @param summary - the session.
 * @param current - the run's session, marked so the page's default is visible.
 * @returns the option's text.
 */
function label(summary: SessionSummary, current: string): string {
  const what = summary.title ?? 'nothing said yet'
  const when = summary.updatedAt === undefined ? 'empty' : formatAge(summary.updatedAt)
  const marker = summary.id === current ? ' · this run' : ''
  return `${what} · ${when} · ${summary.events} events${marker}`
}

/** Whether the pinned session is missing from the list it should be in. */
function unlisted(catalogue: SessionCatalogue, pinned: string | undefined): boolean {
  return pinned !== undefined && !catalogue.sessions.some((summary) => summary.id === pinned)
}

function note(shelf: Exclude<Shelf, { readonly status: 'read' }>): string {
  return shelf.status === 'reading' ? 'reading the shelf…' : `no shelf: ${shelf.why}`
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
