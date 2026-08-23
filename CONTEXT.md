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

**Journal** — the session log written down: one file, one event per JSONL line,
appended as each event commits and replayed when the session is opened. The
file is made by the first append, not by opening: a session nobody said
anything in has no events, and a session with no events must leave nothing
behind. Implemented by `openJournal` in
`packages/core/session/src/journal.ts`, which with `session-store.ts` is all
the package knows about filesystems. Restoring the journal is the whole of
restoring a session — history is the log, and everything else is folded out of
it again. See `docs/adr/0007-the-log-is-the-file.md`.

**Durable before broadcast** — the journal is the log's first observer, so an
event is on disk before any client hears its `seq`. Commit before broadcast,
one layer down: a client that reconnects after a crash and asks for `seq` 7
must find `seq` 7.

**Repair** — what recovery does to a damaged journal: stop at the first line it
cannot vouch for, truncate the file there, and report it. A journal is only
ever a prefix. Bytes after the last newline are a record that was still being
written, and a record that was still being written never happened. Only
opening a session repairs it — listing one reads its file and leaves it alone,
because browsing a shelf must not be a way to lose bytes.

**Session** — one conversation with the harness: an id, and the log of
everything that happened in it. Sessions are plural and independent, and
nothing spans two of them. A run starts a session of its own and loads an
older one only when asked for by name — see
`docs/adr/0009-a-run-starts-a-session.md`.

**Session id** — a session's name, and its journal's file name:
`20260823-074139-k3f9`. UTC and sortable as a string, so a directory listing is
already in the order a human wants to read it. Strictly
`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, because an id arrives from a URL and leaves
as a filename, and the characters that would make one a traversal are simply
not in the set.

**Session store** — where sessions are kept, and the only way the server knows
of finding one: `list`, `has`, `summarise`, `open`, `create`. `openSessionStore`
in `packages/core/session/src/session-store.ts` is a directory of journals;
`createMemorySessionStore` in `apps/dev-server` is the same shelf with nothing
behind it. Opening is the only expensive operation, and the only one nobody
performs by accident: listing reads, it does not open.

**Current session** — the session a request that names none is talking to: the
one this run started, or the one `HARNESS_SESSION` asked for. Not a mode and
not shared state — every route takes `?session=<id>`, and "current" is only
what the harness assumes when nobody says.

**Session summary** — a session as it appears in a list: its id, how many
events it holds, when it started and last moved, and the first thing the human
said, which is its title. Folded out of the events by `summariseEvents` and
never stored beside them: a title written down next to a log is a second source
of truth that starts lying the moment the log grows.

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

**Picker** — the session control in the inspector's header: what is on the
shelf, and the way to another. It reads the list once when it mounts and holds
nothing, because a **session summary** is a fold over a log that keeps growing.
Implemented in `apps/web/src/session-picker.tsx`.

**Pinned page** — an inspector at `?session=<id>`: this log and no other, and a
link somebody can send. A page with no `session` in its query is _following the
run_ instead — the server answers with whatever session it started, so the page
survives a restart of the harness. Choosing a session is a navigation, never a
swap; see `docs/adr/0010-the-page-names-its-session-in-the-url.md`.

**Optimistic turn** — the turn a human has said and the log has not confirmed
yet. Added to the projection by `withOptimistic` and dropped the moment a
`user/message` with the same id lands. Exact rather than heuristic because the
client names the exchange before sending it — see
`docs/adr/0005-the-conversation-is-a-projection.md`.

**Request** — the messages one call to a provider is made of. Never stored:
`deriveMessages` in `packages/core/exchange` folds it out of the log
immediately before every call, so "what does the model see?" is answered by
reading the log rather than by trusting an array somebody remembered to update.

**Message rule** — the entry in `MESSAGE_RULES` that says how one event type
contributes to the **request**. The whole answer to "what would I change to
show the model something new?": an event type affects the request exactly when
the table names it, and a test says so. `assistant/chunk`, `assistant/usage`,
`tool/call` and `error/stream` have no rule, deliberately.

**Tool** — something the model can ask the harness to do: a name, a sentence of
description, a JSON Schema for its arguments, and an `execute`. The description
and the schema are not documentation — they are the entire prompt the model
gets about that tool, and rewriting a description is the most direct way to
change what the model does. Defined in `packages/core/tools`.

**Tool registry** — the set of tools a request is allowed to use. What goes out
with every call as `tools`, and what a returned name is looked up in. An empty
registry sends no `tools` field at all, because a provider handed an empty list
is being told something different from a provider told nothing.

**Tool call** — the model asking for one tool, by name, with arguments as a
JSON _string_. A string rather than a parsed object all the way to the point of
use, because that is what the wire carries, and a model that writes malformed
JSON must be recorded as having written exactly that. Recorded as `tool/call`.

**Tool result** — what the tool said, as text the model will read, plus
`isError`. Recorded as `tool/result`. A **failing tool is a result**, not an
exception: `runTool` never rejects, so every `tool/call` is followed by exactly
one `tool/result` and the log stays balanced. See
`docs/adr/0011-a-failing-tool-is-a-result.md`.

**Step** — one request to the provider inside one **exchange**. An exchange
that calls a tool holds several: step 0 asks, the tool runs, step 1 answers.
The message id names the exchange, so the step is what tells two assistant
replies of it apart — which is why turn keys are `assistant:<id>:<step>` and
why `error/steps` records the step that never ran. Issue #8 makes this a state
machine.

**Model view** — the right column: the **request**, printed as the JSON that
goes on the wire. Not a description of it — the same fold over the same events
gives the same bytes, and that identity is measured from the adapter's argument
through to the text on screen. Implemented in `apps/web/src/model-view.ts`; see
`docs/adr/0006-the-model-view-is-derived.md`.

**Summary** — the one line a row of the event stream shows. Chosen per event
type by a rule table in `apps/web/src/event-summary.ts`, and it leads with what
_differs_: the delta, the arguments, the answer. Never the message id, which is
identical on every row of an exchange — a clipped line of it shows the reader
the one field that cannot tell two rows apart. A type with no rule falls back
to its payload minus the id, so a new event type is legible the day it is
invented. The payload itself is a click away, in full.

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

**Neutral** — any token that is not carrying a meaning of its own: the four
fills, the two rules, the three weights of text. All nine sit on one hue and
none of them is grey, and `--surface` is deliberately not white. The hue is the
accent's, at a fortieth of its chroma, which is what lets a saturated control
read as belonging to the page rather than stuck on it. See
`apps/web/src/styles/theme.css`.

**Tint** — a colour laid over the surface behind it as a wash, at `--tint`, to
make a chip out of the thing written on it: an event type, a turn's role, an
error. Always the same colour as the text in front of it, so a chip never
introduces a colour of its own — and always measured, because a wash of a
colour under that colour is contrast spent. Buying enough headroom for one is
why the family colours are darker in light mode and lighter in dark than they
first shipped. See `docs/adr/0008-tint-elevation-and-motion.md`.

**Elevation** — what floats over what, and the only thing a shadow is allowed
to mean. The inspector header, each panel header and the composer's footer cast
one, because a column scrolls underneath them. The three columns cast none:
they sit side by side in one plane, and a border tells them apart.

**Scheme** — light or dark. Follows the operating system by default, through
`color-scheme: light dark` rather than through JavaScript, and is overruled by
`data-theme` on the root element. The choice lives outside React in
`apps/web/src/theme-store.ts` — it is the only state in `apps/web` that
outlives a render and is not a projection of the log, and it is kept out of the
component tree for the same reason the log is. (The **picker**'s list of
sessions is state too, and deliberately the other kind: local to one component
and thrown away with it.)

## Layout

- `packages/core/session` — the log. Pure; knows nothing about HTTP. Its
  `/journal` and `/store` entry points are the only places `node:fs` appears,
  so the browser imports the vocabulary without the filesystem.
- `packages/core/llm` — provider vocabulary and adapters. Knows nothing about
  the log.
- `packages/core/tools` — what the model can do besides talk: the registry, the
  runner that turns every failure into a result, and the read-only file tools
  behind `/fs`. Knows nothing about the log or about HTTP.
- `packages/core/exchange` — the seam between the two: folds the log into the
  request, runs a model, runs the tools it asked for, and records every delta
  of what it said.
- `packages/client/session-feed` — the replica. Knows about the feed, not about
  React.
- `apps/dev-server` — HTTP front door. Knows about the log, not the reverse.
- `apps/web` — the inspector. Reads the replica; writes nothing.

## Decisions

See `docs/adr/`.
