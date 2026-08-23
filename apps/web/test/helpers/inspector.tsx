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
import type { SessionCatalogue, Sessions } from '../../src/sessions-client.ts'
import { SessionsProvider } from '../../src/sessions-context.tsx'

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
  readonly shelf: FakeShelf
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

/** A shelf nobody has to keep sessions on. */
export interface FakeShelf extends Sessions {
  /** Every session the page asked to look at; `undefined` means "the run's". */
  readonly opened: readonly (string | undefined)[]
  /** How many sessions the page asked to start. */
  readonly starts: number
  /** Answer the read in flight, and flush what that re-renders. */
  answer(catalogue: SessionCatalogue): Promise<void>
  /** Fail the read in flight. */
  refuse(message: string): Promise<void>
  /** Answer the create in flight with the new session's id. */
  started(id: string): Promise<void>
}

/**
 * A shelf that answers nothing until told to.
 *
 * Pending by default on purpose: a picker that has not been answered renders
 * one placeholder and never sets state, so every test that mounts the
 * inspector for some other reason gets no re-render it did not ask for and no
 * `act` warning to go with it.
 *
 * @returns the client, and the controls to answer what it is holding.
 */
export function fakeShelf(): FakeShelf {
  const opened: (string | undefined)[] = []
  const reads: Held<SessionCatalogue>[] = []
  const creates: Held<string>[] = []
  let starts = 0

  const next = <T,>(queue: Held<T>[], what: string): Held<T> => {
    const held = queue.shift()
    if (held === undefined) throw new Error(`no ${what} is in flight`)
    return held
  }

  return {
    opened,
    get starts(): number {
      return starts
    },
    list: async ({ signal } = {}) =>
      new Promise<SessionCatalogue>((resolve, reject) => {
        reads.push({ resolve, reject })
        // Unmounting aborts the read. The picker ignores what comes back;
        // rejecting is how the real client behaves and the only way this
        // promise is ever released.
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      }),
    create: async () => {
      starts += 1
      return new Promise<string>((resolve, reject) => {
        creates.push({ resolve, reject })
      })
    },
    open: (id) => {
      opened.push(id)
    },
    answer: async (catalogue) => {
      await flush(() => {
        next(reads, 'read').resolve(catalogue)
      })
    },
    refuse: async (message) => {
      await flush(() => {
        next(reads, 'read').reject(new Error(message))
      })
    },
    started: async (id) => {
      await flush(() => {
        next(creates, 'create').resolve(id)
      })
    },
  }
}

interface Held<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
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
  const shelf = fakeShelf()

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
        <SessionsProvider sessions={shelf}>
          <App />
        </SessionsProvider>
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
    shelf,
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
