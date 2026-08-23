# ADR-0010 — The page names its session in the URL

- **Status**: accepted
- **Date**: 2026-08-23
- **Refs**: #57, ADR-0002, ADR-0009

## Context

ADR-0009 gave the harness a shelf of sessions and one way to ask for one:
`?session=<id>` on any route. That left the inspector where it always was —
pointed at `/events` with nothing after it, which the server answers with the
session this run started. Correct, and useless for the feature it was built
for: "load an older session on demand" meant `curl`, because the page had no
way to name one.

So the page needs to know which session it is showing, and the question is
where that lives. There are two honest answers.

**In React.** A session id in state at the root, a picker that sets it, and an
effect that tears the feed down and builds another. Instant switching, and no
reload. It also means that during the swap the three panels still hold the old
replica while a new feed starts filling — two replicas of two different logs,
which is the one thing ADR-0002's snapshot contract cannot help with, because
both snapshots are internally consistent and about different conversations. The
feed client's own recovery path makes it worse rather than better: a live feed
handed a lower `seq` treats it as divergence and resyncs, so the seam between
two sessions looks exactly like a bug it knows how to "fix".

**In the URL.** The id is a query parameter, read once at boot, before the
feed, the exchange client, or React exist. Switching is a navigation, and the
page that comes back is the page for that session, entirely.

The second is cheaper in every sense that matters here. The cost is a reload,
which for a page whose entire state is a projection of a log it must re-fetch
anyway is close to free — the theme survives in `localStorage`, and nothing
else on the page was worth keeping.

## Decision

1. **The query names the session, and it is the only place that does.** No
   session id in React state, no store beside the feed, no router.
   `apps/web/src/session-url.ts` is the whole vocabulary: read it out of a
   search string, put it on a URL, navigate to it.

2. **No parameter means "follow the run".** An absent `session` is a choice,
   not a missing value: the server answers it with the session this run
   started, so a page left open on the current session follows the harness
   across a restart. Pinning would leave it staring at a log nothing appends to
   any more, which is the development loop broken in a new way.

3. **An id means this log and no other.** `?session=<id>` is a link somebody
   can send, and a reload that lands where it left off. It is also the only
   thing on the page that survives being copied out of the address bar, which
   is what "on demand" has to mean if it is to be more than a menu.

4. **Choosing the run's own session removes the parameter rather than writing
   it.** The picker knows which id is current and navigates to a bare URL for
   it. Writing the id would be true today and stale tomorrow, and the
   difference between "this session" and "whatever is running" is the point of
   the parameter existing.

5. **Switching sessions is a navigation.** `location.assign`, and the module
   starts again from the top. No feed is closed and rebuilt in place; no panel
   ever sees events from two logs.

6. **The picker reads the shelf once, on mount, and holds nothing.** A summary
   is a fold over a log that is still growing, so a list of them is true for
   about as long as a menu is open. It is not cached, not polled, and not
   pushed down the feed — the feed carries one session's events, and teaching
   it to carry facts about other sessions would make it something else.

7. **The shelf is a capability, handed in like the others.** `Sessions` — list,
   create, open — arrives through context next to the feed and the exchange
   client, and `open` is a navigation the page is _given_ rather than one it
   performs. That is what lets the picker be rendered in a test, which is where
   every rule above is actually checked.

## Consequences

- A session is a URL. Bookmarkable, sendable, and reload-safe, and the back
  button walks through the sessions somebody looked at.
- Switching costs a reload: the feed re-sends the history it already sent, and
  the page repaints from nothing. For a log of a few thousand events on
  localhost this is imperceptible, and it is the price of never holding two.
- The picker's list can be stale — a session started in another tab a minute
  ago is missing until the page is loaded again. Accepted for the same reason
  the summaries are not cached: a wrong list is one reload from being right,
  and the alternative is a second stream of facts about logs the page is not
  reading.
- A URL naming a session that no longer exists shows it in the picker as "not
  on the shelf" and leaves the feed failing to connect. The page says which
  session it believes it is showing, rather than quietly showing a different
  one — the one failure mode that would make an inspector lie.
- `POST /sessions` makes the new session the run's, so "new session" moves
  every client that is following the run, not just the tab that pressed it.
  That is ADR-0009's semantics, surfaced; a per-tab notion of current would be
  a second answer to "which session is this run using".
