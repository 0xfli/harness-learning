# harness-learning

Building a coding agent harness from scratch, one step at a time.
从零手写一个 coding agent harness 的学习仓库。

## What exists today

An append-only session event log, an SSE feed over it, a browser-side replica
of that feed, and a session inspector that renders it. On top of that, a model
adapter whose every streamed delta becomes an event — so the reply is not just
rendered, it is recorded — a conversation column that reads those deltas back
as speech, typewriter and all, without holding a single character of it, and a
third column showing the request itself: the same events folded into the
messages a provider is handed, byte for byte. The log is written to disk as it
grows and replayed on startup, so the session outlives the process. There is no
agent loop and no tools yet.

```
packages/core/session          The log, and the journal that outlives the process.
packages/core/llm              Provider vocabulary and adapters. Knows nothing about the log.
packages/core/exchange         Runs a model and writes down every delta of what it said.
packages/client/session-feed   The replica. Knows about the feed, not about React.
apps/dev-server                HTTP front door: an SSE feed you can curl.
apps/web                       The session inspector: three columns over one log.
```

See [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and [`docs/adr/`](./docs/adr)
for the decisions behind it.

## Requirements

Node.js >= 22 and [pnpm](https://pnpm.io).

```bash
pnpm install
```

## Try it

```bash
pnpm dev
```

That starts the log on `http://localhost:8787` and the inspector on
`http://localhost:5173`. Open the inspector: three columns, each scrolling on
its own, and all three empty — a run starts a session of its own, and nothing
has happened in this one yet. The header says which session that is, and the
middle column has a box at the bottom — that is the next section. The feed is
proxied through Vite, so the page never learns which origin the log lives on.

In another terminal, append a fact and watch every open tab show it at the same
moment, with nothing polling:

```bash
curl -X POST http://localhost:8787/events \
  -H 'content-type: application/json' \
  -d '{"type":"demo/hello","data":{"from":"curl"}}'
```

The new row lands at the bottom and the stream scrolls to meet it — unless you
had scrolled up to read, in which case it stays exactly where you left it. Its
type is a chip, tinted by _family_ — the namespace before the `/` — so
`assistant/chunk` and `assistant/message` read as relatives at a glance, and
the same colour ticks the gutter beside them.

Refresh the page. It looks exactly as it did: the client keeps nothing, and the
server replays the whole log to every new connection.

## Talk to the model

Type into the middle column and press enter. Your message appears immediately —
before any server has heard of it — and the reply types itself out underneath,
a delta at a time. Then look left: the same conversation, spelled out as one
`user/message`, a run of `assistant/chunk`, an `assistant/usage`, and a single
`assistant/message` holding the assembled reply. Two columns, one log.

Nothing in the middle column appends a character to a bubble, and nothing there
holds a copy of the conversation. Both columns are pure functions of the same
event array, which is why refreshing mid-reply reproduces exactly what was on
screen: see [`docs/adr/0005`](./docs/adr/0005-the-conversation-is-a-projection.md).

The same thing works from another terminal, and both tabs show it:

```bash
curl -X POST http://localhost:8787/messages \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'
```

Name the exchange yourself if you want to recognise it when it comes back —
`-d '{"text":"hello","id":"anything-unique"}'`. Every event of it carries that
id, and sending the same one twice is refused with a `409`. That is how the
browser shows your message before the server has heard of it and still does not
show it twice: it picks the name, so the arriving event is the one it is
already displaying rather than one that merely looks like it.

Watch the left column. You get one `user/message`, then a run of
`assistant/chunk` — one event per delta, arriving a word at a time — then
`assistant/usage`, then a single `assistant/message` holding the assembled
reply. Dozens of events for one sentence, which is the point: the streaming
_process_ is recorded, not merely rendered.

Now refresh. Every chunk is still there, in order, with its original
timestamps. That is the difference between accumulating the reply in a
variable and appending each delta as a fact — see
[`docs/adr/0004`](./docs/adr/0004-the-stream-is-a-fact.md), and the deliberate
mistake kept runnable in `packages/core/exchange/test/lost-deltas.test.ts`.

No key is needed: the default adapter is scripted, so it streams the same reply
every time with no network. Point it at a real provider by setting the
environment instead — anything that speaks the OpenAI chat-completions format
will do:

```bash
HARNESS_API_KEY=sk-... \
HARNESS_MODEL=deepseek-chat \
HARNESS_BASE_URL=https://api.deepseek.com/v1 \
pnpm dev
```

That is fine once and a bad habit daily — the key lands in your shell history,
in the process table, and eventually in a screenshot. Write it down instead:

```bash
cp .env.example .env   # then fill in the key; .env is git-ignored
pnpm dev
```

The server looks for `.env` in the working directory and every directory above
it, so the one at the root of the workspace is found whether you run `pnpm dev`
from there or `tsx src/main.ts` from inside `apps/dev-server`. It prints the
path it used at boot, and never what was in it. Anything already set in the
shell wins, so the one-off above still overrules the file without editing it.

| Variable                  | Effect                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `HARNESS_API_KEY`         | Set it to use a real provider; unset for the scripted one.      |
| `HARNESS_MODEL`           | Model id. Required when a key is set; never guessed.            |
| `HARNESS_BASE_URL`        | API root. Defaults to OpenAI's.                                 |
| `HARNESS_REASONING`       | Reasoning effort, `none` through `max`. Provider-dependent.     |
| `HARNESS_THINKING`        | `enabled` or `disabled`. Unset lets the model decide.           |
| `HARNESS_SCRIPT_DELAY_MS` | Milliseconds between scripted deltas. Defaults to 40.           |
| `HARNESS_SESSIONS`        | Directory of session journals. Defaults to `.harness/sessions`. |
| `HARNESS_SESSION`         | Resume this session id at boot. Unset starts a new one.         |
| `HARNESS_ENV_FILE`        | Load this file instead of searching for `.env`. Must exist.     |

## Kill it and carry on

Now the part the first six steps were for. With a conversation on screen, kill
the server outright — `Ctrl-C`, or `kill -9` if you want to be sure no cleanup
runs — and start it again:

```bash
pnpm dev:server
```

It comes back on a **new session**, deliberately: what a run continues is a
choice, and making it silently is how the first question of the morning ends up
at the bottom of last night's conversation — and in front of the model, because
the request is folded out of the log. Nothing was lost. Ask for the shelf:

```bash
curl -s http://localhost:8787/sessions | jq
```

```json
{
  "current": "20260823-091502-p04c",
  "sessions": [
    { "id": "20260823-091502-p04c", "events": 0 },
    {
      "id": "20260823-074139-k3f9",
      "events": 214,
      "startedAt": 1787475699000,
      "updatedAt": 1787476001000,
      "title": "what is a harness?"
    }
  ]
}
```

Every route takes the id of the session it is about, so loading one is one
question — read it, or carry on talking to it:

```bash
curl -N 'http://localhost:8787/events?session=20260823-074139-k3f9'
curl -X POST 'http://localhost:8787/messages?session=20260823-074139-k3f9' \
  -H 'content-type: application/json' -d '{"text":"where were we?"}'
```

The conversation is there, every chunk with its original timestamp, and the
next thing you type continues it. Nothing was rehydrated, because there is
nothing to rehydrate: the file is the log, and the conversation, the request
and the panels are folded out of it exactly as they were a moment ago. Boot
straight back into one with `HARNESS_SESSION=20260823-074139-k3f9 pnpm
dev:server`, and see
[`docs/adr/0009`](./docs/adr/0009-a-run-starts-a-session.md) for why that is
opt-in.

In the inspector the same thing is a menu. The header lists what is on the
shelf — what each session was about, when it last moved, how many events it
holds — and picking one loads it:

```text
session [ what is a harness? · 4m ago · 214 events        ▾ ] [ new ]
```

The page it takes you to is `http://localhost:5173/?session=20260823-074139-k3f9`,
which is the whole trick: the session is named in the URL, so it is a link you
can send and a page that reloads into the same conversation. Leave the
parameter off — by picking the session marked _this run_ — and the page follows
whatever session the harness is on, across restarts and file-watch reloads.
Choosing is a navigation rather than a swap, so no panel ever shows two logs at
once; see
[`docs/adr/0010`](./docs/adr/0010-the-page-names-its-session-in-the-url.md).

One session is one file, and the file's name is the session's id — so `ls`,
`mv` and `rm` are the whole management interface, and a journal from before the
shelf existed keeps its history by moving onto it:

```bash
mkdir -p .harness/sessions && mv .harness/session.jsonl .harness/sessions/legacy.jsonl
```

The file is worth looking at. One event per line, in order:

```bash
wc -l .harness/sessions/*.jsonl
jq -r 'select(.type == "user/message") | .data.text' .harness/sessions/20260823-074139-k3f9.jsonl
```

What is _not_ in it is the point: no conversation, no message array, no
snapshot of anything derived. A snapshot restores a session perfectly under the
code that wrote it and then goes stale the first time a new event type matters —
the fact it needed was dropped before the process exited, and no migration
brings it back. See [`docs/adr/0007`](./docs/adr/0007-the-log-is-the-file.md),
and the deliberate mistake kept runnable in
`packages/core/exchange/test/frozen-snapshot.test.ts`.

A process killed mid-write leaves a half-finished last line. Startup drops it,
truncates the file to the last complete record, and says so — a record that was
still being written never happened, and the prefix in front of it is untouched.
`seq` then continues from the restored length, so no two facts ever answer to
one number. `apps/dev-server/test/restart.test.ts` proves all three against a
process actually killed with `SIGKILL`.

## What the model sees

Now watch the right column while you send a second message. It is not a summary
of the request — it is the request, the exact JSON the provider is handed:

```json
[
  { "role": "user", "content": "hello" },
  { "role": "assistant", "content": "hi there" },
  { "role": "user", "content": "and another thing" }
]
```

Two things are worth staring at. It does not move while a reply streams: the
request was settled before the first delta arrived, so the middle column types
itself out beside a motionless right column. And it grows in one step when
`assistant/message` lands, because deltas are facts about the process and the
assembled message is the fact about the result — sending both would show the
model everything twice.

There is no variable holding that list. `deriveMessages(log)` folds it out of
the events immediately before every call, the browser folds its own replica
with the very same function, and the two agree byte for byte — measured from
the adapter's argument through to the text on screen. Which is why appending
`user/message` before streaming is not merely tidy: appending is how the
message reaches the model at all.

That rule has a name — model-visible implies logged — and one consequence worth
knowing before it surprises you: a reply whose stream died is on screen in the
middle column and absent from the right one. The log never called it finished,
so the model is never told it said it. See
[`docs/adr/0006`](./docs/adr/0006-the-model-view-is-derived.md), and the
deliberate mistake kept runnable in
`packages/core/exchange/test/drifting-messages.test.ts` — a `messages` array
beside the log, agreeing with it in the first test and drifting in the next
three.

## Or without a browser

The feed is plain SSE, so `curl` is a complete client. You get the full history
first, then live events, in `seq` order:

```bash
curl -N http://localhost:8787/events
```

Kill the reader, then reconnect claiming what you already saw. The stream picks
up where you left off, with no duplicates:

```bash
curl -N -H 'Last-Event-ID: 1' http://localhost:8787/events
```

## Using the log directly

```ts
import { SessionLog } from '@harness/session'

const log = new SessionLog()
const unobserve = log.observe((event) => {
  console.log(event.seq, event.type, event.data)
})

log.append('demo/hello', { message: 'the log exists' })
unobserve()
```

`append` validates and deep-copies the payload, assigns `seq` and `time`,
deep-freezes the event, commits it, and only then notifies observers. Events are
immutable, so nothing you hand out can be used to rewrite history. Appending
from inside an observer is rejected rather than silently re-entering.

To keep a log across restarts, restore it from a journal instead:

```ts
import { restoreSession } from '@harness/session/journal'

const { log, close } = restoreSession({ path: '.harness/sessions/legacy.jsonl' })

log.length // however many events the last process left behind
log.append('demo/hello', { message: 'and one more' }) // seq continues from there
close()
```

That is the whole of it. The journal is attached as the log's first observer, so
every event is on disk before any client hears its `seq`, and a damaged tail is
truncated and reported when the session is opened rather than carried forward.
The file itself is made by the first append, so a session nobody said anything
in leaves nothing behind.

For more than one session, use the shelf they sit on:

```ts
import { openSessionStore } from '@harness/session/store'

const sessions = openSessionStore({ dir: '.harness/sessions' })

sessions.list() // every stored session, most recently active first
const session = sessions.create() // a new one, named after the moment it started
sessions.open('20260823-074139-k3f9').log // an older one, loaded because you asked
sessions.close()
```

`list` reads without opening, so a picker can show twenty sessions while the
harness holds one. `node:fs` lives behind the `/journal` and `/store` entry
points alone — `@harness/session` itself stays browser-safe.

## Recording an exchange in code

```ts
import { SessionLog } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import { recordExchange, replayChunks } from '@harness/exchange'

const log = new SessionLog()
const result = await recordExchange({
  log,
  adapter: createScriptedAdapter(),
  text: 'hello',
})

replayChunks(log.events, result.id) === result.text // always
```

`recordExchange` appends `user/message` _before_ the request, because the
messages sent to the provider are `deriveMessages(log)` — projected back out of
the log rather than threaded through as an argument, so the log is the source of
truth even for the request being built from it. Then one `assistant/chunk` per
delta, `assistant/usage` when the provider reports it, and `assistant/message`
last. Last is a guarantee, not an accident: its presence is how anything
downstream knows the reply is complete.

If the stream dies halfway, the deltas that arrived stay in the log and an
`error/stream` event says where it stopped. Nothing is ever un-appended.

## Reading the feed from a client

```ts
import { createSessionFeed } from '@harness/session-feed'

const feed = createSessionFeed({ url: '/events' })

feed.events.subscribe(() => {
  console.log(feed.events.getSnapshot().length, feed.status.getSnapshot())
})
```

`events` and `status` are `{ subscribe, getSnapshot }` pairs — the shape React's
`useSyncExternalStore` asks for, with no React in the package. `getSnapshot`
returns the same frozen array until the log actually grows; see
[`docs/adr/0002`](./docs/adr/0002-snapshot-identity-is-the-contract.md) for why
that identity is the whole contract.

In the inspector that is one hook and no state:

```ts
export function useSessionEvents(): readonly SessionEvent[] {
  const feed = useFeed()
  return useSyncExternalStore(feed.events.subscribe, feed.events.getSnapshot)
}
```

Every panel is a projection of what that returns. No component holds
conversation or domain data in `useState`, and no component fetches for itself.
The conversation is the clearest case — one pure fold, grouping chunks by
message id and concatenating them:

```ts
const turns = deriveConversation(events) // apps/web/src/conversation.ts
const messages = deriveMessages(events) // @harness/exchange, same as the server
```

A reply that is still streaming is a turn whose fold has not finished. Nothing
appends to it; the array grew and the same function ran again. The second line
is the same one the server runs to build a request, which is the whole reason
the right column can be trusted: it is not showing you a request, it is
computing the one that would be made.

## Scripts

```bash
pnpm test        # vitest: the node suites and the jsdom one
pnpm typecheck   # tsc --noEmit, workspace and web app
pnpm lint        # oxlint
pnpm format      # oxfmt, in place
pnpm run check   # format check + lint + typecheck + test, what CI runs
pnpm build       # production build of the inspector
pnpm dev         # log on :8787 and inspector on :5173, both with reload
pnpm dev:server  # just the log
pnpm dev:web     # just the inspector
```

`pnpm install` also installs the git hooks: staged files are formatted and
linted on commit, commit subjects must be
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and
typecheck plus tests run before a push. See [`AGENTS.md`](./AGENTS.md) for the
full conventions.
