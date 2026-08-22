# ADR-0007 — The file holds the log, not the fold

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #6, ADR-0001, ADR-0004, ADR-0006

## Context

Everything so far has been true only for as long as the process lived. The log
is the system of record, the conversation is a projection of it, the request is
a projection of it — and all three vanished on `Ctrl-C`. That was tolerable
while a session was three `demo/hello` events. It stopped being tolerable the
moment a reply became a hundred `assistant/chunk` events that took real seconds
and, against a real provider, real money to produce.

The question is not whether to write something down. It is _what_.

The tempting answer is the thing you were about to render. A session is, after
all, a conversation: save the turns, or the messages, and load them back. The
file is small, it loads in one `JSON.parse`, and it restores the session
perfectly — under the code that wrote it.

The bill arrives with the first new event type. A fold keeps what the rules of
the day asked for and drops the rest; `assistant/usage` contributes nothing to
the request, so a request-shaped snapshot does not contain it, and the token
metering in #21 cannot be run over last week's sessions. Not because the format
is old — because the fact was thrown away before the process exited. Every
snapshot file also has to carry the version of the code that produced it, so
every future reader carries a migration for every past writer, and the answer
to "what did this session actually contain?" becomes "whatever the loader for
version 3 makes of it".

Replaying a log has neither problem. New rules re-decide an old session,
because the evidence is still there. The deliberate mistake is kept runnable in
`packages/core/exchange/test/frozen-snapshot.test.ts`: it restores identically
under the code that wrote it, and fails the moment a `tool/result` rule exists.

## Decision

1. **The file is the log, one event per line.** JSONL, appended as each event
   commits. Chosen for its failure mode, not its ergonomics: a single JSON
   document has to be rewritten and re-parsed whole, so a kill mid-write turns
   "lost the last fact" into "lost every fact". Line-delimited records fail one
   line at a time.
2. **A journal is only ever a prefix.** Recovery stops at the first line it
   cannot vouch for — torn, unparseable, or claiming the wrong `seq` — and
   truncates the file there. Truncating is load-bearing rather than tidy: the
   next append would otherwise continue the half-written line and destroy a
   readable record along with the unreadable one. A repair is reported, never
   silent.
3. **Bytes after the last newline never happened.** A record without its
   terminator is a record that was still being written. The terminator is part
   of the encoding for exactly this reason, and recovery works on byte offsets
   rather than characters, because one multi-byte character in a payload would
   otherwise cut a line in the wrong place.
4. **Restoring is loading history, not rebuilding state.** `new SessionLog({
history })` and nothing else: the conversation, the request and every panel
   are folded out of those same events again. There is no second thing to
   rehydrate, which is the whole payoff of the first six steps.
5. **`seq` continues from the length of the restored history.** History must be
   dense and zero-based or the constructor throws. `append` derives the next
   `seq` from the length, so a hole would hand a new fact a number an old fact
   already answers to, and every cursor downstream would resolve `seq` 4 to
   whichever arrived last.
6. **Durable before broadcast.** The journal is attached as the log's first
   observer, so an event is on disk before any client is told its `seq`. The
   same argument as commit-before-broadcast, one layer down: a client that
   reconnects after a crash and asks for `seq` 7 must find `seq` 7.
7. **The write is synchronous.** `writeSync` returns once the bytes are with
   the operating system, which is what makes a killed process a non-event. It
   is deliberately _not_ an `fsync`: this survives a process dying, not a
   machine losing power. A dev harness that paid a disk flush per delta would
   stream at the speed of the disk.
8. **The filesystem lives behind its own entry point.** `@harness/session`
   stays pure and browser-safe; `@harness/session/journal` is the only module
   that imports `node:fs`. The inspector imports the vocabulary of the log
   without ever pulling in a filesystem.

## Consequences

- Killing the server and starting it again continues the conversation, and the
  browser does not know it happened: the feed replays the restored log exactly
  as it replayed the in-memory one. `apps/dev-server/test/restart.test.ts`
  proves it against a process actually killed with `SIGKILL`, because a
  graceful shutdown runs the very cleanup a crash skips.
- The log grows without bound, and now it does so on disk. Nothing prunes it,
  and nothing should at this stage — #22 prunes what the _model_ is shown,
  which is a projection, and leaves the record alone.
- A journal is a plain text file, so `wc -l`, `grep` and `jq` are a debugging
  toolkit, and a bug report can be an attachment.
- One session per file, named by `HARNESS_SESSION`. Multiple sessions, and the
  question of who is allowed to write to one, are not answered here.
- Demo events are seeded only into an empty log. Seeding a restored session
  would append three invented facts to a real conversation on every restart —
  which is what durability does to code that assumed a fresh start.
- An event that fails to write is reported, not undone: an observer runs after
  the commit and cannot veto it. The process therefore continues with a log
  that is ahead of its file. For a dev harness that is the honest trade, and
  the report is the signal to stop trusting the file.
