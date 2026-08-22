# harness-learning

Building a coding agent harness from scratch, one step at a time.
从零手写一个 coding agent harness 的学习仓库。

## What exists today

An append-only session event log, an SSE feed over it, a browser-side replica
of that feed, and a session inspector that renders it. On top of that, a model
adapter whose every streamed delta becomes an event — so the reply is not just
rendered, it is recorded — and a conversation column that reads those deltas
back as speech, typewriter and all, without holding a single character of it.
There is no agent loop and no tools yet.

```
packages/core/session          The log. Pure; knows nothing about HTTP.
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
its own, and the left one already filled with the seeded history. The middle
one has a box at the bottom — that is the next section. The feed is proxied
through Vite, so the page never learns which origin the log lives on.

In another terminal, append a fact and watch every open tab show it at the same
moment, with nothing polling:

```bash
curl -X POST http://localhost:8787/events \
  -H 'content-type: application/json' \
  -d '{"type":"demo/hello","data":{"from":"curl"}}'
```

The new row lands at the bottom and the stream scrolls to meet it — unless you
had scrolled up to read, in which case it stays exactly where you left it. Its
type is coloured by _family_, the namespace before the `/`, so `assistant/chunk`
and `assistant/message` read as relatives at a glance.

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

| Variable                  | Effect                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `HARNESS_API_KEY`         | Set it to use a real provider; unset for the scripted one. |
| `HARNESS_MODEL`           | Model id. Required when a key is set; never guessed.       |
| `HARNESS_BASE_URL`        | API root. Defaults to OpenAI's.                            |
| `HARNESS_SCRIPT_DELAY_MS` | Milliseconds between scripted deltas. Defaults to 40.      |

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
messages sent to the provider are projected back out of the log rather than
threaded through as an argument — the log is the source of truth even for the
request being built from it. Then one `assistant/chunk` per delta,
`assistant/usage` when the provider reports it, and `assistant/message` last.
Last is a guarantee, not an accident: its presence is how anything downstream
knows the reply is complete.

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
```

A reply that is still streaming is a turn whose fold has not finished. Nothing
appends to it; the array grew and the same function ran again.

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
