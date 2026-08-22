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

## Layout

- `packages/core/session` — the log. Pure; knows nothing about HTTP.
- `apps/dev-server` — HTTP front door. Knows about the log, not the reverse.

## Decisions

See `docs/adr/`.
