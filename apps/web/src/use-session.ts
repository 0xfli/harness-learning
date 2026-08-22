/**
 * Reading the log from React.
 *
 * `useSyncExternalStore` is the whole integration: the store is the source of
 * truth, a component subscribes to it, and React re-renders exactly the
 * components that read a value which changed. There is no copy of the log in
 * component state, because a copy is a second source of truth.
 *
 * @module
 */

import { useSyncExternalStore } from 'react'
import type { SessionEvent } from '@harness/session'
import type { FeedStatus } from '@harness/session-feed'
import { useFeed } from './feed-context.tsx'

/**
 * Every event received so far, in `seq` order.
 *
 * @returns the current snapshot. Its identity changes only when the log grew,
 *   so a component that reads it re-renders only then.
 */
export function useSessionEvents(): readonly SessionEvent[] {
  const feed = useFeed()
  return useSyncExternalStore(feed.events.subscribe, feed.events.getSnapshot)
}

/**
 * Where the connection is.
 *
 * Deliberately a separate subscription from {@link useSessionEvents}: a
 * component that only wants to know whether the stream is live has no reason
 * to re-render when an event arrives.
 *
 * @returns the current connection status.
 */
export function useFeedStatus(): FeedStatus {
  const feed = useFeed()
  return useSyncExternalStore(feed.status.subscribe, feed.status.getSnapshot)
}
