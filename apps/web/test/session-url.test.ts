/**
 * The query string is the answer to "which log is this?".
 *
 * Two states, and the difference between them is the whole feature: an id
 * pins the page to one session, and no id at all leaves the choice to the
 * server — which is what lets a page left open follow the harness across a
 * restart instead of staring at a session that ended.
 */

import { describe, expect, it } from 'vitest'
import { searchForSession, sessionInSearch, withSession } from '../src/session-url.ts'

describe('a page with no session in its query', () => {
  it('is following the run', () => {
    expect(sessionInSearch('')).toBeUndefined()
    expect(sessionInSearch('?')).toBeUndefined()
    expect(sessionInSearch('?theme=dark')).toBeUndefined()
  })

  it('asks for nothing in particular', () => {
    // The server answers a request that names no session with the run's own,
    // so the absence of a parameter is a choice rather than a missing one.
    expect(withSession('/events', undefined)).toBe('/events')
    expect(searchForSession(undefined)).toBe('')
  })
})

describe('a page pinned to a session', () => {
  it('reads the id out of its own URL', () => {
    expect(sessionInSearch('?session=20260823-074139-k3f9')).toBe('20260823-074139-k3f9')
    expect(sessionInSearch('session=20260823-074139-k3f9')).toBe('20260823-074139-k3f9')
    expect(sessionInSearch('?theme=dark&session=old')).toBe('old')
  })

  it('treats an empty parameter as no parameter', () => {
    // `?session=` is what a URL looks like after somebody deletes the id by
    // hand. Passing an empty string along would ask the server for a session
    // named nothing, which is a 400 rather than the run's log.
    expect(sessionInSearch('?session=')).toBeUndefined()
  })

  it('names the session on every request the page makes', () => {
    expect(withSession('/events', 'old')).toBe('/events?session=old')
    expect(withSession('/messages', 'old')).toBe('/messages?session=old')
    expect(searchForSession('old')).toBe('?session=old')
  })

  it('adds to a query rather than replacing one', () => {
    // `VITE_FEED_URL` can carry its own parameters, and losing them here
    // would be a bug that only shows up in somebody else's setup.
    expect(withSession('/events?after=12', 'old')).toBe('/events?after=12&session=old')
  })

  it('escapes what it is given', () => {
    // The server rejects an id like this outright; the page still must not be
    // the thing that smuggles it into a URL.
    expect(withSession('/events', 'a b&c=d')).toBe('/events?session=a%20b%26c%3Dd')
    expect(searchForSession('../../etc/passwd')).toBe('?session=..%2F..%2Fetc%2Fpasswd')
  })
})
