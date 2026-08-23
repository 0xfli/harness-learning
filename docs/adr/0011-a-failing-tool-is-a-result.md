# ADR-0011 — A failing tool is a result, and the log must balance

- **Status**: accepted
- **Date**: 2026-08-24
- **Refs**: #7

## Context

The obvious way to run a tool is to call it:

```ts
const result = await tool.execute(JSON.parse(call.arguments), context)
log.append('tool/result', { callId: call.id, content: result.content })
```

That is what was written first, and it worked on every path that succeeded.
Then `read_file` was pointed at a file that was not there, `fs.readFile` threw
`ENOENT`, the exception unwound past the `append`, and out of the top of
`recordExchange`.

The visible damage was one dead turn: a 502, no reply, an error in the console.
Annoying, and apparently local — the sort of thing a `try`/`catch` around the
call site fixes.

It was not local. The `tool/call` event had already been appended. The
`tool/result` never was. And the log is not a transcript of what happened; it
is the thing every subsequent request is folded out of. So the next message —
a new exchange, about something else entirely — folded a history containing an
assistant message with `tool_calls` and nothing answering them, and the
provider refused it:

```
400 An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'. The following tool_call_ids did not have
response messages: call_1
```

Three properties of that failure are worth naming, because together they are
what makes it worse than an ordinary bug.

It is **permanent**. A log is append-only (ADR-0001). There is no operation
that removes the dangling call. The session is broken for as long as it exists,
and the only recovery is to abandon it.

It is **delayed and misattributed**. The message that breaks is not the message
that broke it. Somebody meets this while typing "hello" and goes looking at the
code that handles "hello".

It is **invisible at the boundary that caused it**. Nothing about
`await tool.execute(...)` says "this expression can poison a session". A
throwing function looks exactly like a non-throwing one.

The instinct is to wrap the call site. That does fix this instance. It does not
fix the _class_, because it leaves the invariant — one result per call, always
— as something each caller has to remember, and the punishment for forgetting
is a bug that shows up somewhere else, later, in someone else's session.

## Decision

1. **A tool's failure is a value, not an exception.** `execute` returns
   `{ content, isError }`, and `isError: true` is an ordinary return. There is
   no error channel and nothing for a caller to catch.

2. **`runTool` never rejects.** Unknown tool, unparseable arguments, arguments
   that are not an object, a throw, a rejection, an abort, a malformed return
   value — all of them become a `ToolResult`. It is a total function, and the
   only place in the codebase that knows how a tool can go wrong. Callers do
   not need a `try`, so they cannot forget one.

3. **The `tool/result` append is unconditional.** `runCalls` has no `try`, no
   `catch` and no `finally`, because there is no path through it on which the
   append can be skipped. The invariant is not enforced by discipline; it is
   enforced by there being nothing else the code can do.

4. **The failure is told to the model, in the only place it reads.** A provider
   has no field for "this result is bad news", so the news has to be the
   content: `"notes/missing.md" does not exist` goes back as the tool message,
   and the model apologises, or lists the directory, or asks. `isError` is kept
   on the event for the human in the inspector, and is not sent.

5. **The step is bounded and the bound is recorded.** A model that calls a tool
   forever is stopped at `maxSteps`, and `error/steps` is appended saying so —
   a limit that stops a run silently is a limit nobody can debug.

## Consequences

The log balances by construction: every `tool/call` is followed by exactly one
`tool/result`, so every history `deriveMessages` can produce is one a provider
will accept. That is asserted directly rather than assumed — see
`packages/core/exchange/test/unbalanced-history.test.ts`, which builds the
poisoned log by hand, watches a strict provider refuse it, and then shows the
real loop cannot produce one.

The pending tool card in the inspector falls out of the same invariant for
free. A card is pending exactly while the log holds a `tool/call` with no
`tool/result` beside it. Nothing sets that state and nothing clears it; the
gap that makes the log balance is the gap the human watches.

The cost is that a tool author cannot signal "something went so wrong that the
turn should stop". That is deliberate. In a harness the model is the thing that
decides what to do about a failure, and it cannot decide about a failure it was
never told about. If a future step needs a genuinely fatal tool — one that must
end the run — it will need its own event type and its own place in the state
machine, not an exception thrown through a loop that is holding an invariant.

`isError` is therefore advisory everywhere except the inspector, and that is
the honest description of it: a hint for a human reading the log, not a control
flow signal for the harness.
