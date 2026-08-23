/**
 * Which session this page is looking at.
 *
 * The answer is in the URL, and nowhere else. That is worth being deliberate
 * about, because the obvious alternative — a session id held in React and
 * swapped in place — means closing one feed and opening another while three
 * panels still hold the old log, and two replicas are zero replicas the moment
 * they disagree. A page shows one log; asking for a different one is a
 * navigation, and the page that comes back is the page for that session,
 * entirely.
 *
 * The query has two states, and the difference between them matters:
 *
 * - **No `session`** — whatever session this run of the harness started. The
 *   server resolves it, so a page left open follows the server across a
 *   restart, which is the normal development loop.
 * - **`?session=<id>`** — this log and no other, pinned. A link somebody can
 *   send, which is the whole point of loading a session on demand.
 *
 * @module
 */

const PARAMETER = 'session'

/**
 * The session named in a query string.
 *
 * @param search - a `location.search`, with or without its leading `?`.
 * @returns the id, or `undefined` when the page is following the run.
 */
export function sessionInSearch(search: string): string | undefined {
  const id = new URLSearchParams(search).get(PARAMETER)
  return id === null || id === '' ? undefined : id
}

/**
 * A URL that names the session.
 *
 * @param url - the endpoint, which may already carry a query.
 * @param id - the session, or `undefined` to leave the choice to the server.
 * @returns the URL the page should use.
 */
export function withSession(url: string, id: string | undefined): string {
  if (id === undefined) return url
  return `${url}${url.includes('?') ? '&' : '?'}${PARAMETER}=${encodeURIComponent(id)}`
}

/**
 * The query string for a session.
 *
 * @param id - the session, or `undefined` to follow the run.
 * @returns `?session=<id>`, or an empty string.
 */
export function searchForSession(id: string | undefined): string {
  return id === undefined ? '' : `?${PARAMETER}=${encodeURIComponent(id)}`
}

/**
 * Look at a session.
 *
 * A real navigation rather than a swap: everything on the page is a projection
 * of one log, so the cheapest correct way to project a different one is to
 * start again.
 *
 * @param id - the session, or `undefined` to follow the run.
 */
export function goToSession(id: string | undefined): void {
  const { location } = globalThis
  location.assign(`${location.pathname}${searchForSession(id)}`)
}
