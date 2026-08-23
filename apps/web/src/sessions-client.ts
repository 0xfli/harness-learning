/**
 * The shelf, from the page's side of the wire.
 *
 * Three verbs, because three is what a picker needs: what is on the shelf,
 * start another, look at one. The third is a navigation rather than a request,
 * and it sits here with the other two anyway — a component that can list
 * sessions but has to reach for `location` itself is a component that cannot
 * be rendered in a test.
 *
 * Nothing here is cached. The list is read once when the picker mounts and is
 * never held, because a list of sessions is a summary of logs that keep
 * growing, and a stale copy of it would be a page confidently describing
 * yesterday.
 *
 * @module
 */

import type { SessionSummary } from '@harness/session'
import { goToSession } from './session-url.ts'

/** What is on the shelf, and which one this run of the harness is using. */
export interface SessionCatalogue {
  /** The session a request that names none is answered with. */
  readonly current: string
  /** Every session, most recently active first. */
  readonly sessions: readonly SessionSummary[]
}

/** The three things a picker does. */
export interface Sessions {
  /**
   * Read the shelf.
   *
   * @param options - an abort signal, so a picker that unmounts mid-request
   *   does not come back to set state on a component nobody is rendering.
   */
  list(options?: { readonly signal?: AbortSignal }): Promise<SessionCatalogue>
  /**
   * Start a session nobody has used before, and make it the run's.
   *
   * @returns the new session's id.
   */
  create(): Promise<string>
  /**
   * Look at a session.
   *
   * @param id - the session, or `undefined` to follow whatever session the
   *   run is using.
   */
  open(id: string | undefined): void
}

/** How to reach the shelf. */
export interface SessionsClientOptions {
  /** Where to ask. Relative by default, so it follows the serving origin. */
  readonly url?: string
  /** What looking at a session does. A navigation, unless a test says so. */
  readonly open?: (id: string | undefined) => void
}

const DEFAULT_URL = '/sessions'

/**
 * Build the client the picker talks to.
 *
 * @param options - where to ask, and what opening a session means.
 * @returns the client.
 */
export function createSessionsClient(options: SessionsClientOptions = {}): Sessions {
  const url = options.url ?? DEFAULT_URL
  const open = options.open ?? goToSession

  return {
    list: async ({ signal } = {}) => {
      const response = await fetch(url, signal === undefined ? {} : { signal })
      if (!response.ok) throw new Error(await failureMessage(response))
      return toCatalogue(await response.json())
    },
    create: async () => {
      const response = await fetch(url, { method: 'POST' })
      if (!response.ok) throw new Error(await failureMessage(response))
      const body = (await response.json()) as { current?: unknown }
      if (typeof body.current !== 'string') throw new Error('the harness named no session')
      return body.current
    },
    open,
  }
}

/**
 * What came back, read defensively.
 *
 * A summary arrives without the fields it has nothing to say about — JSON has
 * no `undefined` — so every one of them is rebuilt here rather than assumed
 * present. The page renders whatever the shelf answered; it does not decide
 * the answer was malformed and blank the header over it.
 *
 * @param body - the parsed response.
 * @returns the catalogue.
 * @throws when the body is not a catalogue at all.
 */
function toCatalogue(body: unknown): SessionCatalogue {
  const { current, sessions } = body as { current?: unknown; sessions?: unknown }
  if (typeof current !== 'string' || !Array.isArray(sessions)) {
    throw new Error('the harness answered with something that is not a session list')
  }
  return { current, sessions: sessions.map((entry) => toSummary(entry)) }
}

function toSummary(entry: unknown): SessionSummary {
  const summary = entry as Partial<Record<keyof SessionSummary, unknown>>
  return {
    id: typeof summary.id === 'string' ? summary.id : '',
    events: typeof summary.events === 'number' ? summary.events : 0,
    startedAt: typeof summary.startedAt === 'number' ? summary.startedAt : undefined,
    updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : undefined,
    title: typeof summary.title === 'string' ? summary.title : undefined,
  }
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0) return body.error
  } catch {
    // A failure whose body is not JSON is still a failure, and the status is
    // the only thing left worth reporting.
  }
  return `the harness answered ${response.status}`
}
