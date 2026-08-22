/**
 * How a component reaches the feed: through context, never by constructing one.
 *
 * A component that opened its own connection would hold a second replica of
 * the log, and two replicas are zero replicas the moment they disagree.
 *
 * @module
 */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { SessionFeed } from '@harness/session-feed'

const FeedContext = createContext<SessionFeed | undefined>(undefined)

/** Props for {@link FeedProvider}. */
export interface FeedProviderProps {
  /** The one feed this tree reads from. */
  readonly feed: SessionFeed
  readonly children: ReactNode
}

/**
 * Make one feed available to a tree.
 *
 * @param props - the feed and the tree that reads it.
 * @returns the provider element.
 */
export function FeedProvider({ feed, children }: FeedProviderProps): ReactNode {
  return <FeedContext value={feed}>{children}</FeedContext>
}

/**
 * The feed this tree reads from.
 *
 * @returns the feed.
 * @throws when called outside a {@link FeedProvider} — a component that cannot
 *   find the feed must fail loudly rather than invent one.
 */
export function useFeed(): SessionFeed {
  const feed = useContext(FeedContext)
  if (feed === undefined) {
    throw new Error('useFeed must be called inside a FeedProvider')
  }
  return feed
}
