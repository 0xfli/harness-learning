# ADR-0001 — The session log is a ledger, not a list

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #1

## Context

The harness records everything it knows as an ordered sequence of events, and
broadcasts each one to connected clients. Every later feature — replay, undo,
persistence, a UI that renders history, a model that reads back its own
transcript — assumes the log is a faithful account of what happened.

The first cut of `append` skipped the freeze: it pushed the caller's object
straight into the array. That version passes a happy-path test and is wrong.
Holding a reference to an already-appended event is enough to rewrite history:

```ts
const event = log.events[0]
event.data.message = 'never actually happened'
```

Re-read the log and the past has changed, with no record that it did. The same
hole exists on the way in — an appended object the caller still holds can be
mutated afterwards, and the log silently follows along.

A second failure mode showed up with observers. Because observers are called
during `append`, an observer that appends re-enters `append` while the first one
is still broadcasting. Sequence numbers interleave, observers receive events out
of order, and every observer is reasoning about a log that is halfway through
changing.

## Decision

1. **Snapshot on the way in.** `append` deep-copies `data` into plain JSON. The
   caller keeps its own object; the log keeps a detached copy.
2. **Reject what JSON cannot hold.** `NaN`, `Infinity`, `bigint`, symbols,
   functions, `Date`, class instances, and cycles are refused rather than
   silently coerced. A ledger that turns `NaN` into `null` lies about what it
   was told. Own properties whose value is `undefined` are dropped, matching
   `JSON.stringify`.
3. **Deep-freeze on the way out.** The whole event — `seq`, `type`, `time`, and
   every node under `data` — is frozen before anyone can reach it. In strict
   mode (all of our modules) a write throws instead of failing silently.
4. **Commit before broadcast.** The event is pushed, and only then are observers
   notified. Never the reverse.
5. **Refuse re-entrant appends.** A guard is raised for the whole
   commit-and-broadcast window; appending from inside an observer throws.
6. **Contain observer failures.** A throwing observer is reported through
   `onObserverError` and the remaining observers still run. The event is already
   committed; a broken listener is not a reason to pretend the fact never
   happened.

## Consequences

- Event payloads must be JSON. Richer types have to be encoded explicitly, which
  is the right pressure: an event that cannot be serialised cannot be persisted
  or streamed either.
- `append` costs a deep copy and a deep freeze. Payloads are small and the
  guarantee is worth more than the cycles.
- Observers that want to react by appending must defer — for example with
  `queueMicrotask` — which makes the causal chain visible rather than hidden
  inside one call stack.
- Freezing is not encryption. It stops accidental mutation and honest mistakes;
  it does not defend against an attacker in the same process.
