# CONTEXT.md

Domain vocabulary for `harness-learning`. Use these terms verbatim in code,
tests, issues, and commit messages.

## Glossary

**Session log** — the append-only, ordered record of everything the harness
knows about one session. The system of record: state is derived from the log,
never the other way around. Implemented by `SessionLog` in
`packages/core/session`.

**Event** — one fact in the session log: `{ seq, type, time, data }`. Immutable
once appended. Not "message", not "record", not "entry".

**Seq** — an event's zero-based position in the log. Dense, gapless, assigned
by `append`, never reused. It is the only ordering anyone should rely on, and
doubles as the SSE `id` so a reconnecting client can resume from it.

**Append** — the single way a fact enters the log. Validates, freezes, commits,
then broadcasts — in that order.

**Commit before broadcast** — the rule that an event is in the log before any
observer hears about it. An observer that reads the log must see the event that
woke it; a client told about `seq` 7 must be able to fetch `seq` 7.

**Observer** — a callback attached with `SessionLog.observe`, invoked once per
committed event. Observers are post-commit and cannot veto, undo, or reorder an
append. An observer that throws is contained and reported, not propagated.

**Feed** — the SSE stream that carries the log to a client: full history first,
then live events, in `seq` order. Implemented in `apps/dev-server/src/sse.ts`.

**Cursor** — per-connection state on the feed: the next `seq` that connection is
owed. The only thing that decides what gets sent, which is what makes "no gaps,
no duplicates" hold.

**Feed client** — the browser half of the feed: it holds a _replica_ of the log
and exposes it as an external store. Implemented by `createSessionFeed` in
`packages/client/session-feed`.

**Replica** — the events a feed client has received so far. Always a prefix of
the log, or thrown away. It is never edited, never merged, and never a second
source of truth.

**Snapshot** — the frozen array a feed client hands to its view layer. Its
_identity_ is the signal: the same reference means nothing changed. A snapshot
that is freshly allocated per read says "everything changed" forever — see
`docs/adr/0002-snapshot-identity-is-the-contract.md`.

**Projection** — anything derived from the log by pure computation. Panels are
projections; so is the message list a model sees. A projection is recomputed,
never maintained.

**Adapter** — one provider, reduced to what the harness needs: `stream(messages)
-> AsyncIterable<StreamChunk>`. Adapters translate a wire format and nothing
else — they never touch the log. Implemented in `packages/core/llm`.

**Chunk** — one thing that happened while the model was replying, as the
adapter reports it: a `text-delta`, a `finish`, or a `usage`. A discriminated
union, so a new kind breaks every exhaustive `switch` until it is handled.

**Delta** — the text carried by one `text-delta` chunk. Recorded verbatim as an
`assistant/chunk` event; the concatenation of a reply's deltas equals its
`assistant/message` text, byte for byte. See
`docs/adr/0004-the-stream-is-a-fact.md`.

**Exchange** — one `user/message` and the reply it produced: the chunks, the
usage, and the assembled message, all sharing one **message id**. Recorded by
`recordExchange` in `packages/core/exchange`. `assistant/message` is always
last, and its presence is what "the reply is complete" means.

**Message id** — ties every event of one exchange together. `seq` orders the
whole log; the id says which reply a delta belongs to, which is what keeps two
concurrent replies separable when their chunks interleave.

**Inspector** — the three-column page: the event stream on the left, the
conversation in the middle, the model's view on the right. Three projections of
one log; keeping them in agreement is the whole job of a harness. Implemented in
`apps/web`. Each column scrolls on its own — reading one against another is the
point, and a single page scrollbar would move all three at once.

**Turn** — one bubble in the conversation: what the human said, or the reply it
produced. Derived by `deriveConversation` in `apps/web/src/conversation.ts`,
never stored. An assistant turn is the concatenation of its deltas until
`assistant/message` arrives with the assembled text, so a reply that is still
streaming is simply one whose fold has not finished. A turn's key is `role:id`,
because a **message id** names an exchange and both halves of one carry it.

**Composer** — the box at the bottom of the conversation column. It submits
through a form action, so "sending" and "that failed" are the action's own
state rather than flags somebody has to remember to clear, and the request
stays open for as long as the model is replying.

**Optimistic turn** — the turn a human has said and the log has not confirmed
yet. Added to the projection by `withOptimistic` and dropped the moment a
`user/message` with the same id lands. Exact rather than heuristic because the
client names the exchange before sending it — see
`docs/adr/0005-the-conversation-is-a-projection.md`.

**Family** — the namespace at the front of an event type: `assistant/chunk` and
`assistant/message` are both the `assistant` family. The unit the inspector
colours, so a new type in a known family needs no new colour and reads as
related on sight. Implemented in `apps/web/src/event-colour.ts`.

**Token** — a named value in `apps/web/src/styles/theme.css`. Colours carry
both their light and their dark value in one `light-dark()` declaration; the
tint, elevation, radius and motion scales are single values. Tokens are named
for what they mean — `--faint`, `--border`, `--type-assistant`, `--shadow-md` —
never for what they look like, and they are the only place such a value is
written down. A stylesheet names tokens; markup names neither. See
`docs/adr/0003-tokens-not-utilities.md`.

**Tint** — a colour laid over the surface behind it as a wash, at `--tint`, to
make a chip out of the thing written on it: an event type, a turn's role, an
error. Always the same colour as the text in front of it, so a chip never
introduces a colour of its own — and always measured, because a wash of a
colour under that colour is contrast spent. Buying enough headroom for one is
why the family colours are darker in light mode and lighter in dark than they
first shipped. See `docs/adr/0006-tint-elevation-and-motion.md`.

**Elevation** — what floats over what, and the only thing a shadow is allowed
to mean. The inspector header, each panel header and the composer's footer cast
one, because a column scrolls underneath them. The three columns cast none:
they sit side by side in one plane, and a border tells them apart.

**Scheme** — light or dark. Follows the operating system by default, through
`color-scheme: light dark` rather than through JavaScript, and is overruled by
`data-theme` on the root element. The choice lives outside React in
`apps/web/src/theme-store.ts` — it is the only state in `apps/web` that is not
a projection of the log, and it is kept out of the component tree for the same
reason the log is.

## Layout

- `packages/core/session` — the log. Pure; knows nothing about HTTP.
- `packages/core/llm` — provider vocabulary and adapters. Knows nothing about
  the log.
- `packages/core/exchange` — the seam between the two: runs a model and records
  every delta of what it said.
- `packages/client/session-feed` — the replica. Knows about the feed, not about
  React.
- `apps/dev-server` — HTTP front door. Knows about the log, not the reverse.
- `apps/web` — the inspector. Reads the replica; writes nothing.

## Decisions

See `docs/adr/`.
