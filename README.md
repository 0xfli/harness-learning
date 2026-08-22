# harness-learning

Building a coding agent harness from scratch, one step at a time.
从零手写一个 coding agent harness 的学习仓库。

## What exists today

An append-only session event log and an SSE feed over it. There is no agent and
no UI yet — `curl` is the demo.

```
packages/core/session   The log. Pure; knows nothing about HTTP.
apps/dev-server         HTTP front door: an SSE feed you can curl.
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

In another terminal, open the feed. You get the full history first, then live
events, in `seq` order:

```bash
curl -N http://localhost:8787/events
```

In a third terminal, append a fact and watch it land in every open stream:

```bash
curl -X POST http://localhost:8787/events \
  -H 'content-type: application/json' \
  -d '{"type":"demo/hello","data":{"from":"curl"}}'
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

## Scripts

```bash
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint
pnpm format        # oxfmt, in place
pnpm run check     # format check + lint + typecheck + test, what CI runs
pnpm dev           # run the dev server with reload
```

`pnpm install` also installs the git hooks: staged files are formatted and
linted on commit, commit subjects must be
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and
typecheck plus tests run before a push. See [`AGENTS.md`](./AGENTS.md) for the
full conventions.
