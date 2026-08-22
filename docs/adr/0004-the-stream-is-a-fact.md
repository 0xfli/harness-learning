# ADR-0004 — The stream is a fact, not a rendering detail

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #3

## Context

The model replies a token at a time. Something has to turn that stream into
something the rest of the harness can use, and the obvious version is four
lines:

```ts
let text = ''
for await (const chunk of adapter.stream(messages)) text += chunk.text
log.append('assistant/message', { text })
```

It works. The reply appears, the conversation is correct, the log has a message
in it. The cost is invisible until the page is reloaded, and then it is total:
the log says a reply exists and says nothing about how it arrived. No order,
no timing, no partial state. A reply that streamed over twelve seconds and one
that arrived in a single frame produce byte-identical logs.

That matters because every interesting question about streaming is a question
about the process, not the result. Did it stall halfway? Did the user see a
truncated sentence before the socket dropped? Which deltas had we rendered when
the tool call came in? A local `text` variable can answer all of those while
the function is on the stack, and none of them one millisecond after it
returns. The information was never destroyed by a bug — it was simply never
written down.

The same argument the server made in ADR-0001 about state applies to process:
if it is not in the log, it did not happen, and no amount of careful rendering
downstream can recover it.

## Decision

1. **Every delta is an event.** One `assistant/chunk` per `text-delta` the
   provider emits, carrying the delta verbatim and its `index` within the
   reply. The concatenation of the chunks is the message — a property under
   test, because a lossy split would make the log a paraphrase of the stream
   rather than a record of it.
2. **`assistant/message` is a summary, not the only trace.** It is appended
   last, always, and its presence is what "this reply is complete" means.
   Readers test for it rather than inferring completeness from a pause.
3. **Chunks carry a message id, not just a position.** `seq` orders the whole
   log; the id says which reply a delta belongs to. Two exchanges in flight at
   once interleave in the log and must still be separable, and the conversation
   projection in #4 groups on exactly this.
4. **The finish reason lives on the message.** It is not an event of its own,
   because one fact recorded in two places is one fact that can disagree with
   itself.
5. **Usage is its own event.** It is a different kind of fact from the reply —
   it is about the request — and it arrives at a different time. Recording it
   separately is what lets the context-pressure work in #21 read cost off the
   log rather than recomputing it.
6. **A stream that fails records `error/stream` and keeps its deltas.** The
   partial reply is not garbage to be rolled back; it is what actually
   happened, and it is the only evidence of where the failure landed. Nothing
   is ever un-appended.
7. **The chunk union is discriminated, not an optional-field bag.** A new chunk
   kind should break every exhaustive `switch` until it is handled. The
   compiler is the only reviewer that reads every call site.
8. **The request is read back out of the log.** `user/message` is appended
   _before_ the provider call, and the messages sent are projected from the log
   — so the log is the source of truth even for the request being built from
   it. #5 replaces the two-line projection with a real `deriveMessages`; the
   rule is already in place.

## Consequences

- The log grows fast. A hundred-token reply is a hundred-odd events, and the
  event stream panel fills with them — which is the point of this step being
  visible before there is any conversation UI to look at.
- Anything can replay a reply offline: `replayChunks(events, id)` works on a
  log loaded from disk, in a test, or pasted into a console. Debugging a stream
  no longer requires reproducing it.
- Recording usage per exchange makes cost a queryable property of the log
  rather than a number that scrolled past in a terminal.
- Durability is now load-bearing rather than nice to have. A restart still
  loses everything, which is #6's problem, and this step makes it a more
  expensive one.
- The deliberate mistake is kept executable in
  `packages/core/exchange/test/lost-deltas.test.ts`, including the assertion
  that most deserves to stay: a streamed reply and a single-shot reply produce
  identical logs under the naive version.
