# ADR-0002 — The browser holds a replica, and its snapshot identity is the contract

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #2

## Context

The log lives on the server and arrives in the browser as a feed. Something in
the browser has to hold what has arrived so far and let a view read it
synchronously, because rendering cannot await.

The obvious place to put it is component state: subscribe in an effect, push
each event into a `useState` array. That version renders, and it is wrong in
three ways at once. The array is a second source of truth that drifts from the
log the moment any branch forgets to update it. Every component that wants
events either duplicates the subscription or receives the array through props
from whichever component happened to own it. And nothing outside React can read
the log, so a test, a console session, or a future non-React surface all have
to boot a renderer first.

React has a purpose-built answer — `useSyncExternalStore` — and it comes with a
contract that is easy to violate and expensive to violate. `getSnapshot` must
return the _same reference_ until the data actually changes. The deliberate
mistake for this step is one line:

```ts
getSnapshot: () => [...this.#log]
```

The data is correct. A fresh array every call means React compares the snapshot
it just read against the snapshot it read a moment ago, finds a different
reference, concludes the store changed, and re-renders — which reads the
snapshot again. React notices and says so ("The result of getSnapshot should be
cached to avoid an infinite loop") before throwing on the render depth limit,
but by then the tab is unusable.

The server's rule was "an event is frozen so nobody can rewrite the past". This
is the same rule from the other side: a snapshot whose identity churns claims
the past was rewritten, on every single read.

## Decision

1. **The replica lives outside the view layer.** `createSessionFeed` opens the
   connection and owns the array. React is one possible subscriber, not the
   owner. It follows that no component holds domain data in `useState` and no
   component opens its own connection.
2. **`getSnapshot` returns a cached frozen array**, rebuilt only when the log
   changed — the same lazy `#snapshot` cache the server keeps behind
   `SessionLog.events`. Identity change means "the log grew", and nothing else.
3. **Events and connection status are separate stores.** They change for
   unrelated reasons, so a new event must not re-render the connection
   indicator and a reconnect must not re-render the event list.
4. **`seq` is a position, not a hint.** An event either lands at the end of
   what we hold or the replica is wrong. A hole (`seq` ahead of the end) and a
   divergence (a position we already hold coming back with different content,
   which is what a restarted server replays) both mean the array is no longer a
   prefix of the log. Both throw the replica away and rebuild it over a fresh
   connection, which sends no `Last-Event-ID` and therefore replays from `seq` 0.
   The same event arriving twice is the one benign case and is ignored.
5. **The wire is validated at the boundary and frozen on the way in.** A frame
   that is not a well-formed event is reported and dropped rather than applied.
   The server hands out frozen events; a replica that handed out mutable ones
   would give the view a way to rewrite history that the server itself does not
   have.
6. **Contained failures are reported, never propagated.** A malformed frame, a
   hole, or a subscriber that throws goes to `onError`; the remaining
   subscribers still run. A broken renderer is not a reason to drop the feed.

## Consequences

- Reading history in the browser costs a `slice` per change rather than per
  read. Renders are far more frequent than appends, which is the right way
  round.
- Any surface can read the log — a test drives the feed with a fake transport
  and asserts on snapshots without rendering anything.
- Resync is destructive by design: a client that has admitted it holds the
  wrong history briefly shows nothing rather than showing a history that never
  happened. With a durable log and a session identity, a cheaper reconciliation
  becomes possible; that is not this step.
- A restarted dev server (`tsx watch` reloads constantly) is handled by the
  divergence path rather than by leaving a stale page behind.
