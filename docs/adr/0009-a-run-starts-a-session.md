# ADR-0009 — A run starts a session; older ones are loaded by name

- **Status**: accepted
- **Date**: 2026-08-23
- **Refs**: #57, ADR-0001, ADR-0007

## Context

ADR-0007 made the file the log and called restoring it "the whole of restoring
a session". It was right about durability and quiet about scope: there was one
journal, named by `HARNESS_SESSION`, and the harness opened it at boot. Its own
consequences flagged what that left open — _"One session per file… Multiple
sessions, and the question of who is allowed to write to one, are not answered
here."_

With one file, "restore the journal" and "resume the conversation" are the same
sentence, so nobody had to decide which one they meant. They are not the same
thing, and the difference is the whole of this decision:

- **Restoring** is a property of the record. A fact that was recorded is still
  there tomorrow. This is worth everything it cost.
- **Resuming** is a choice about _this_ run. It belongs to whoever started the
  harness, and it was being made for them, silently, every time.

Made silently it is usually wrong. A `tsx watch` reload picks the conversation
back up mid-thought. The first question of the morning lands at the bottom of
last night's log — and because the request is a fold over the log (ADR-0006),
the model is shown all of it. Starting clean means deleting the file, which
also throws away the only copy of what it held, so the two things a person
actually wants — _a fresh session_ and _that session from Tuesday_ — are the
two things one file cannot both be.

The fix is not to stop writing. It is to stop assuming.

## Decision

1. **Sessions are plural, and a directory is the shelf.** One session is one
   journal; the journal's file name is the session's **id**. That is the entire
   mapping, and it is deliberately one a human can operate: `ls` lists the
   sessions, `mv` renames one, `rm` deletes one, and nothing has to be told
   afterwards.
2. **A run starts a session of its own.** Nothing is resumed unless something
   asks for it by name — `?session=<id>` on any route, or `HARNESS_SESSION` at
   boot. An id nobody recognises is refused rather than created, because a
   typo that quietly opened an empty session looks exactly like a conversation
   that vanished.
3. **The first append makes the file.** Opening a journal reads; it does not
   create. A session nobody said anything in has no events, and a session with
   no events never happened — it must not leave a nought-byte file behind for
   the shelf to offer as a conversation. This is what makes "every run starts a
   session" affordable at all: a watch process that reloads eleven times leaves
   nothing but the one session somebody typed into.
4. **An id is a name, not a path.** `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, checked
   before it is ever spelled into a filename. An id arrives from a URL; the two
   characters that would turn one into a traversal are simply not in the set,
   which is a smaller thing to get right than sanitising a path afterwards.
5. **There is no index.** Listing reads every journal and folds each into a
   summary — the count, the first and last event times, and the first thing the
   human said. A file that recorded what a session contains would be a second
   source of truth about a log that already knows, and it would start lying the
   first time somebody deleted a journal by hand. This is linear in what is on
   disk, which is the right trade for tens of sessions and the wrong one for
   millions; when it stops being right, the answer is a cache in front of the
   files, never a file that claims to know better than they do.
6. **A session's title is its opening question.** The one label nobody has to
   invent, keep in step, or migrate, because it is already in the log.
7. **The store is an interface, and the filesystem is one implementation.** The
   server takes a `SessionStore`; `@harness/session/store` is the directory of
   journals, and the dev server falls back to one that keeps sessions in memory
   and forgets them. A server that reached for a filesystem when a store was
   missing would be a server with two ways of finding a log.
8. **`seq` stays per session, and a feed stays one cursor over one log.** A
   client that wants another session opens another stream; it does not resume
   across the boundary. Making `seq` globally unique would buy nothing and cost
   the property every cursor downstream depends on — that an event's position
   _is_ its number.
9. **Nothing is seeded.** The three `demo/hello` events that used to greet an
   empty log would now be three invented facts written into a file on every new
   session. A new session is empty, and the composer is the thing that fills
   it.

## Consequences

- Starting the harness twice in a morning leaves two sessions, and the second
  one does not know what the first said. That is the point, and it is also the
  cost: continuing yesterday's work is now an act — one `?session=`, one click
  in the picker — rather than the default.
- The shelf grows without bound and nothing prunes it. `ls -lt
.harness/sessions` and `rm` are the tools, which is the same answer ADR-0007
  gave for the log's own growth and for the same reason: the record is not the
  thing to economise on.
- A journal from before this change is not read: the harness looks in a
  directory now. Keeping it is a `mv .harness/session.jsonl
.harness/sessions/legacy.jsonl` away, and its id is then `legacy` — which is
  the mapping in rule 1 paying for itself.
- Listing a session reads its file and never repairs it. Recovery still
  truncates a damaged tail, but only when the session is actually opened:
  browsing a shelf must not be a way to lose bytes.
- Two processes over one shelf can still both open the same session, and
  nothing stops them. They would each derive the next `seq` from their own view
  of it and write two different facts under one number — the failure ADR-0007
  described one layer down. One writer per session remains an assumption, and
  it is now a smaller one, because two runs no longer default to the same
  session.
