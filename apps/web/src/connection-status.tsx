/**
 * Whether the feed is live, and nothing else.
 *
 * @module
 */

import type { ReactNode } from 'react'
import type { FeedStatus } from '@harness/session-feed'
import { useFeedStatus } from './use-session.ts'

const LABELS: Record<FeedStatus, string> = {
  connecting: 'connecting',
  open: 'live',
  reconnecting: 'reconnecting',
  closed: 'closed',
}

/**
 * The connection indicator.
 *
 * It subscribes to the status store only, so events arriving by the hundred
 * never re-render it.
 *
 * @returns the indicator element.
 */
export function ConnectionStatus(): ReactNode {
  const status = useFeedStatus()
  return (
    // `output` is the live region for a value the page keeps updating; it
    // carries `role="status"` implicitly.
    <output className="connection-status" data-status={status}>
      <span className="connection-dot" aria-hidden="true" />
      {LABELS[status]}
    </output>
  )
}
