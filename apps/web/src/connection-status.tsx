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
    <p className="connection-status" data-status={status} role="status">
      <span className="connection-dot" aria-hidden="true" />
      {LABELS[status]}
    </p>
  )
}
