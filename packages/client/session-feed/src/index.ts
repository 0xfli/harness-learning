/**
 * The client half of the feed: a replica of the session log that a view layer
 * can read synchronously.
 *
 * @module @harness/session-feed
 */

export { createSessionFeed } from './session-feed.ts'
export type { SessionFeed, SessionFeedOptions } from './session-feed.ts'
export type {
  ExternalStore,
  FeedError,
  FeedErrorReason,
  FeedSource,
  FeedSourceFactory,
  FeedSourceMessage,
  FeedStatus,
} from './types.ts'
