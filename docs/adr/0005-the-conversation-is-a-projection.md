# ADR-0005 — The conversation is a projection, and the client names the exchange

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #4, ADR-0001, ADR-0002, ADR-0004

## Context

The middle column has to do two things that pull in opposite directions. It has
to show a reply arriving a token at a time, and it has to show the human's own
message the instant it is typed — before any server has heard of it.

The obvious implementation does both with local state:

```tsx
const [messages, setMessages] = useState([])
// on submit
setMessages((all) => [...all, { role: 'user', text }])
// on each chunk
setMessages((all) => extendLast(all, chunk.text))
```

Every line of that is a second source of truth. It disagrees with the log on
reload, on reconnect, on a resync, and in a second tab — and the disagreement
is invisible until one of those happens, at which point the page is showing a
conversation that never took place. ADR-0001 settled this for the server: state
is derived from the log, never the other way around. The browser does not get
an exemption because it has a `useState`.

Optimism is where it gets interesting. `POST /messages` stays open for the
whole reply, and the `user/message` event comes down the feed near the start of
it — so for the several seconds the model is talking, the optimistic copy and
the real event coexist. A plain `useOptimistic` renders both, and the human
watches their own message sit on screen twice while the answer types itself
underneath. Reconciliation cannot wait for the request to finish; it has to
happen when the event arrives.

Matching by text would work until somebody says "ok" twice. Matching by
position is worse. The only exact answer is an identity both sides already
agree on — and the log already has one. `recordExchange` ties every event of a
turn together with a **message id** (ADR-0004). The only reason the browser
cannot use it is that the server invents it.

## Decision

1. **The conversation is `deriveConversation(events)`** — a pure fold over the
   event array, recomputed on every render, memoised only on the snapshot's
   identity (ADR-0002). The column holds no `useState`, and there is no code
   anywhere that appends a character to a bubble. The typewriter is what
   recomputing a projection over a growing array of facts looks like.
2. **The optimistic turn is part of the same projection.** `withOptimistic` is
   a pure function of the derived turns and the message in flight; React's
   `useOptimistic` supplies the second argument for exactly as long as the
   action runs. Nothing is inserted into the replica, and nothing is deleted
   from it.
3. **The client names the exchange.** The browser generates the message id and
   sends it with the message; the server uses it for every event of that
   exchange. Reconciliation is then a key comparison — the optimistic turn
   stops being added because the log now has one with the same id — rather
   than a guess about text or timing.
4. **A reused id is refused with 409.** Accepting a name from the outside means
   accepting that it can collide, and two exchanges under one id would fold
   into one turn in every reader downstream. The log cannot un-append the
   second, so the request is refused before the first append.
5. **Pending and error come from the form action.** `useActionState` owns both:
   the composer is shut for as long as the request is open, and a failure is
   the action's return value rather than a flag set in a `catch` that somebody
   has to remember to unset in a `finally`.
6. **`assistant/message` wins over the client's own concatenation.** They agree
   byte for byte in a healthy log; when they cannot, the log's summary is the
   one to believe, and no reader has to trust a client's string handling.
7. **What a reply cost is not part of the conversation.** `assistant/usage` is
   a fact about the request. It belongs to the right-hand column, which #5
   builds.

## Consequences

- Reload, reconnect, resync and a second tab are all free, and not because they
  were handled: there is nothing to handle. Replaying the log calls the same
  pure function with the same input.
- The whole conversation is refolded once per event — O(n) per delta, O(n²)
  over a reply. Memoising on snapshot identity keeps it to one fold per fact
  rather than one per render, and at the scale of a session log that is fine.
  The moment it is not, the fix is an incremental fold behind the same
  signature, and no caller changes.
- The composer is shut for the length of a reply. That is honest — one exchange
  is in flight and the server is streaming it — but it also means there is no
  way to cancel, which is a gap that a later step has to close rather than
  paper over.
- The server now accepts an identifier from the outside. It is validated,
  length-capped, and checked against the log, which is three checks that would
  not exist if the server named everything. The reward is that "show it
  immediately, do not show it twice" is an equality rather than a heuristic.
- React 19 entangles every async action in flight into one transition, and that
  entanglement is global rather than per root. It is invisible in a browser,
  where requests settle, and it deadlocks a test file that walks away from an
  open one — so the test harness settles what it opened. Noted here because it
  is the kind of thing that costs an hour twice.
- There is no deliberate mistake kept runnable for this step. The thing worth
  noticing is the code that is absent: no append-a-character effect, no
  `messages` state, no "did the server confirm it yet" flag. That absence is
  the payoff for the previous four steps, and the only way to see it is to look
  for it.
