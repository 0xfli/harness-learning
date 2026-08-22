/**
 * Mounting the inspector over a feed nobody has to serve, and an exchange
 * client nobody has to run a model for.
 *
 * @module
 */

import { act, fireEvent, render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { onTestFinished } from 'vitest'
import { createSessionFeed } from '@harness/session-feed'
import type { FeedError, SessionFeed } from '@harness/session-feed'
import { fakeTransport, wireEvent } from '@harness/session-feed/testing'
import type { FakeTransport } from '@harness/session-feed/testing'
import { App } from '../../src/app.tsx'
import type { OutgoingMessage, StartExchange } from '../../src/exchange-client.ts'
import { ExchangeProvider } from '../../src/exchange-context.tsx'
import { FeedProvider } from '../../src/feed-context.tsx'

/** Exchanges the page started, held open until the test says otherwise. */
export interface FakeExchanges {
  /** Every message sent, in order, with the id the client chose for it. */
  readonly sent: readonly OutgoingMessage[]
  readonly start: StartExchange
  /** The reply finished, as far as the caller is concerned. */
  settle(): void
  /** The request failed. */
  fail(message: string): void
  /** Let go of everything still open, so the next test starts clean. */
  abandon(): void
}

/**
 * An exchange client that never returns until told to.
 *
 * A real `POST /messages` stays open for as long as the model is talking, and
 * that window is exactly where the optimistic turn lives — so a fake that
 * resolved immediately would test nothing.
 *
 * @returns the client, and the controls to settle what it is holding.
 */
export function fakeExchanges(): FakeExchanges {
  const sent: OutgoingMessage[] = []
  const inFlight: { resolve: () => void; reject: (error: unknown) => void }[] = []

  const next = (): { resolve: () => void; reject: (error: unknown) => void } => {
    const held = inFlight.shift()
    if (held === undefined) throw new Error('no exchange is in flight')
    return held
  }

  return {
    sent,
    start: async (message) => {
      sent.push(message)
      await new Promise<void>((resolve, reject) => {
        inFlight.push({ resolve, reject })
      })
    },
    settle: () => {
      next().resolve()
    },
    fail: (message) => {
      next().reject(new Error(message))
    },
    abandon: () => {
      for (const held of inFlight.splice(0)) held.resolve()
    },
  }
}

/** A mounted inspector, plus the transport and the exchange client driving it. */
export interface MountedInspector extends RenderResult {
  readonly feed: SessionFeed
  readonly transport: FakeTransport
  readonly errors: readonly FeedError[]
  readonly exchanges: FakeExchanges
  /** Deliver events to the current connection, the way the server would. */
  send(...events: readonly { seq: number; type: string; time: number }[]): void
  /** Bring the connection up. */
  open(): void
  /** Close the feed, as leaving the page would. */
  close(): void
  /** Type into the composer and submit it, the way a human would. */
  say(text: string): Promise<void>
  /** Let the exchange in flight finish, and flush what that re-renders. */
  settle(): Promise<void>
  /** Fail the exchange in flight, and flush what that re-renders. */
  fail(message: string): Promise<void>
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
  const exchanges = fakeExchanges()

  // React 19 entangles every async action that is in flight at the same time
  // into one transition, and that entanglement is global rather than per root.
  // A test that walks away from an open exchange would therefore hold the
  // *next* test's form pending forever. In a browser the request always
  // settles; here it has to be made to.
  onTestFinished(async () => {
    await flush(() => {
      exchanges.abandon()
    })
  })

  const view = render(
    <FeedProvider feed={feed}>
      <ExchangeProvider start={exchanges.start}>
        <App />
      </ExchangeProvider>
    </FeedProvider>,
  )

  const field = (): HTMLTextAreaElement => {
    const found = view.container.querySelector('.composer-input')
    if (found === null) throw new Error('the composer has no input')
    return found as HTMLTextAreaElement
  }

  return {
    ...view,
    feed,
    transport,
    errors,
    exchanges,
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
    say: async (text) => {
      const input = field()
      fireEvent.change(input, { target: { value: text } })
      await act(async () => {
        fireEvent.submit(input.form as HTMLFormElement)
      })
    },
    settle: async () => {
      await flush(() => {
        exchanges.settle()
      })
    },
    fail: async (message) => {
      await flush(() => {
        exchanges.fail(message)
      })
    },
  }
}

/**
 * Do something outside React and let everything it started finish.
 *
 * Settling an exchange resolves a promise the form action is awaiting, which
 * resolves the action, which is what updates the form's own state — several
 * microtask turns after the call that started it. One `act` is not enough.
 *
 * @param change - what to do.
 */
async function flush(change: () => void): Promise<void> {
  change()
  await act(async () => {
    // A macrotask, not a microtask: React runs the action's result through its
    // own scheduler, which lands on a later task. Resolving the request first
    // and waiting afterwards keeps this timer behind the work it is waiting
    // for.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export { wireEvent }
