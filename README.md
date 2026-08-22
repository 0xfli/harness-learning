# harness-learning

Building a coding agent harness from scratch, one step at a time.
从零手写一个 coding agent harness 的学习仓库。

## What exists today

An append-only session event log, an SSE feed over it, a browser-side replica
of that feed, and a session inspector that renders it. There is no agent yet —
the log is filled by hand with `curl`.

```
packages/core/session          The log. Pure; knows nothing about HTTP.
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
`http://localhost:5173`. Open the inspector: three columns, and the left one
already filled with the seeded history. The feed is proxied through Vite, so
the page never learns which origin the log lives on.

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
