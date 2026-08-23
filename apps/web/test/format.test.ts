/**
 * How long ago, in the four sizes a picker needs.
 *
 * The thresholds are the whole point: a list of sessions is scanned, not read,
 * and "17 minutes" and "18 minutes" are the same fact. What must not happen is
 * a session from last month reading as "37d ago", which is a date somebody has
 * to work out with a calendar.
 */

import { describe, expect, it } from 'vitest'
import { formatAge, formatDate } from '../src/format.ts'

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ago = (distance: number): string => formatAge(NOW - distance, NOW)

describe('something that just happened', () => {
  it('is just now, up to the point where a minute is worth saying', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(44 * SECOND)).toBe('just now')
    expect(ago(45 * SECOND)).toBe('1m ago')
  })

  it('is still just now when the clocks disagree', () => {
    // The server's timestamps and the browser's clock come from different
    // machines. A session written "in 3 minutes" is a true statement about
    // those two clocks and a useless one about the session.
    expect(formatAge(NOW + 5 * MINUTE, NOW)).toBe('just now')
  })
})

describe('something older', () => {
  it('is counted in the largest unit that still fits', () => {
    expect(ago(9 * MINUTE)).toBe('9m ago')
    expect(ago(90 * MINUTE)).toBe('2h ago')
    expect(ago(3 * DAY)).toBe('3d ago')
  })

  it('becomes a date once "ago" stops helping', () => {
    expect(ago(6 * DAY)).toBe('6d ago')
    expect(ago(30 * DAY)).toBe(formatDate(NOW - 30 * DAY))
  })
})

describe('a date', () => {
  it('is written the way a session id is', () => {
    // Same order as the id the session is filed under, so a list sorted by one
    // reads as if it were sorted by the other.
    expect(formatDate(Date.UTC(2026, 0, 5, 12))).toMatch(/^2026-01-0[45]$/)
  })
})
