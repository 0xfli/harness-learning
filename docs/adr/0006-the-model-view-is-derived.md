# ADR-0006 — The model's view is derived, and the column is the request

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #5, ADR-0001, ADR-0004, ADR-0005

## Context

A harness has three readers of one session: the log, the human, and the model.
The first two were settled by ADR-0001 and ADR-0005 — both are derived, neither
is maintained. The third is the one everybody gets wrong, because the wrong
version is so comfortable:

```ts
const messages: ModelMessage[] = []
// on submit
messages.push({ role: 'user', content: text })
// when the reply finishes
messages.push({ role: 'assistant', content: assembled })
```

It needs no fold, it is O(1) per turn, and on the happy path it is correct.
That is precisely the problem. It is correct on the paths whose author
remembered it, and silently wrong on the rest: a message appended through
`POST /events`, a session restored from disk, a reply that died halfway, and —
the one every harness eventually hits — the branch that records a tool result.
Nothing throws. The model is simply shown a conversation that did not happen,
while the inspector's middle column shows one that did.

Two sources of truth is zero sources of truth. And the array is the weaker of
the two by construction: it does not survive a restart, it cannot be audited
after the fact, and rebuilding it means writing the fold anyway — under duress,
and probably not the same fold.

The deliberate mistake is kept runnable in
`packages/core/exchange/test/drifting-messages.test.ts`. It agrees with the log
in the first test and disagrees in the next three.

## Decision

1. **The request is `deriveMessages(log)`**, recomputed immediately before
   every call to a provider. No variable anywhere holds conversation history —
   which is also why `recordExchange` appends `user/message` _before_
   streaming: appending is how the message reaches the model at all.
2. **One rule table decides what the model sees.** `MESSAGE_RULES` maps an
   event type to the message it contributes, and a test asserts that an event
   type changes the request exactly when the table names it. Teaching the model
   about a new kind of fact — a tool result, a system contribution, a content
   block — is therefore one entry and no caller changes.
3. **Model-visible implies logged.** The only way to put something in front of
   a model is to append an event and give its type a rule. There is no other
   door, and nothing can be sent that a reader of the log cannot see.
4. **The right column is the request, not a rendering of it.** The browser
   folds its replica with the same `deriveMessages` the server builds a request
   with, and paints `JSON.stringify(messages, null, 2)` — the bytes that go on
   the wire. The split into one block per message exists only so each can carry
   its family colour; the concatenation of what is on screen is asserted to be
   the whole serialisation, character for character.
5. **Byte-identity is measured across the stack, not asserted in one process.**
   `apps/dev-server/test/model-view.test.ts` runs a real server, watches the
   feed as a browser does, folds what arrives, and compares it with the request
   the adapter was actually handed. `apps/web/test/model-view.test.ts` closes
   the last hop, from the messages to the pixels' worth of text.
6. **Deltas, usage and failures contribute nothing.** A chunk is a fact about
   the process and the assembled `assistant/message` is the fact about the
   result; sending both would show the model everything twice. Usage is a fact
   about the request. And an exchange that ended in `error/stream` never
   produced a reply the log calls finished, so it contributes no assistant
   message at all.

## Consequences

- The right-hand column does not move while a reply is streaming. That
  stillness is information: the request was settled before the first delta
  arrived, and the middle column typing itself out beside a motionless right
  column is the clearest picture of what a turn actually is.
- A reply that died halfway is visible to the human and absent from the model.
  The columns disagree, on purpose and in public. The alternative — sending the
  partial text — means inventing a turn the model never finished and the log
  never called complete, to fix an appearance rather than a fact. What the
  human saw is still in the log, so a later step can change its mind by adding
  a rule rather than by finding where the history is kept.
- A retry after a failure sends two user messages in a row. That is what
  happened, and it is a shape every provider accepts.
- The fold is O(n) per request, and the browser refolds on every event. At
  session scale that is nothing, and the fix — an incremental fold behind the
  same signature — changes no caller. Both readers memoise on the snapshot's
  identity (ADR-0002), so it is one fold per fact rather than one per render.
- `@harness/exchange` now re-exports `ModelMessage` and `MessageRole`. It is
  the seam that decides what a model is shown, so the inspector can read the
  vocabulary of a request without taking a dependency on provider adapters.
- Nothing in the browser can add to the request. A composer that wanted to send
  the model a hint would have to append an event for it — which is the rule
  working, not the rule getting in the way.
- No endpoint hands the browser a message list, and none should: a second way
  to learn what the model sees is a second thing that can be wrong. The feed is
  sufficient, and a test says so.
