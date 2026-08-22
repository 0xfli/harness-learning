/**
 * Mounting the inspector over a feed nobody has to serve.
 *
 * @module
 */

import { act, render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { createSessionFeed } from '@harness/session-feed'
import type { FeedError, SessionFeed } from '@harness/session-feed'
import { fakeTransport, wireEvent } from '@harness/session-feed/testing'
import type { FakeTransport } from '@harness/session-feed/testing'
import { App } from '../../src/app.tsx'
import { FeedProvider } from '../../src/feed-context.tsx'

/** A mounted inspector, plus the transport driving it. */
export interface MountedInspector extends RenderResult {
  readonly feed: SessionFeed
  readonly transport: FakeTransport
  readonly errors: readonly FeedError[]
  /** Deliver events to the current connection, the way the server would. */
  send(...events: readonly { seq: number; type: string; time: number }[]): void
  /** Bring the connection up. */
  open(): void
  /** Close the feed, as leaving the page would. */
  close(): void
}

/**
 * Mount the whole page over a hand-driven feed.
 *
 * @returns the render result, the feed, and the transport behind it.
 */
export function mountInspector(): MountedInspector {
  const transport = fakeTransport()
  const errors: FeedError[] = []
  const feed = createSessionFeed({
    createSource: transport.createSource,
    onError: (error) => errors.push(error),
  })

  const view = render(
    <FeedProvider feed={feed}>
      <App />
    </FeedProvider>,
  )

  return {
    ...view,
    feed,
    transport,
    errors,
    send: (...events) => {
      // Frames arrive outside React, exactly as they will in the browser; act
      // is what tells React the resulting renders have been flushed.
      act(() => {
        for (const event of events) transport.current().send(event)
      })
    },
    open: () => {
      act(() => {
        transport.current().open()
      })
    },
    close: () => {
      act(() => {
        feed.close()
      })
    },
  }
}

export { wireEvent }
