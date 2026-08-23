/**
 * The left column: the log itself, one line per event.
 *
 * This is the only panel that subscribes to events, which is what makes an
 * arriving event re-render this column and nothing else.
 *
 * @module
 */

import type { CSSProperties, ReactNode } from 'react'
import type { SessionEvent } from '@harness/session'
import { eventColourToken, eventFamily } from '../event-colour.ts'
import { messageIdOf, payloadOf, summariseEvent } from '../event-summary.ts'
import { formatClock } from '../format.ts'
import { useSessionEvents } from '../use-session.ts'
import { useTailFollow } from '../use-tail-follow.ts'
import { Panel, PanelPlaceholder } from './panel.tsx'

/**
 * Every event in the log, oldest first, following the tail.
 *
 * @returns the event stream column.
 */
export function EventStreamPanel(): ReactNode {
  const events = useSessionEvents()
  const tail = useTailFollow(events.length)

  return (
    <Panel
      title="Event stream"
      note={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      bodyRef={tail.ref}
      onBodyScroll={tail.onScroll}
    >
      {events.length === 0 ? (
        <PanelPlaceholder>waiting for the first event</PanelPlaceholder>
      ) : (
        <ol className="event-list">
          {events.map((event) => (
            // `seq` is a position in an append-only log, so it is a real
            // identity rather than the array-index key it looks like.
            <EventRow key={event.seq} event={event} />
          ))}
        </ol>
      )}
    </Panel>
  )
}

interface EventRowProps {
  readonly event: SessionEvent
}

/**
 * One event: a line that says what happened, and the payload behind it.
 *
 * The disclosure is a native `<details>`, so the browser owns whether a row is
 * open. Nothing here holds that, nothing re-renders when it changes, and a
 * row that is open stays open while a hundred events arrive above it — the
 * same reason the composer's textarea is uncontrolled.
 *
 * @param props - the event to draw.
 * @returns the row element.
 */
function EventRow({ event }: EventRowProps): ReactNode {
  const payload = payloadOf(event)
  const id = messageIdOf(event)
  // The row carries its colour as a custom property and the stylesheet decides
  // what to paint with it. React's style types do not know about those.
  const colour = { '--event-colour': `var(${eventColourToken(event.type)})` } as CSSProperties

  return (
    <li className="event-item" style={colour}>
      <details className="event-details">
        <summary
          className="event-row"
          data-seq={event.seq}
          data-type={event.type}
          data-family={eventFamily(event.type)}
          {...(id === undefined ? {} : { 'data-message-id': id })}
        >
          <span className="event-seq">{event.seq}</span>
          <time className="event-time" dateTime={new Date(event.time).toISOString()}>
            {formatClock(event.time)}
          </time>
          <span className="event-type">{event.type}</span>
          <span className="event-data">{summariseEvent(event)}</span>
        </summary>
        {payload === '' ? null : <pre className="event-payload">{payload}</pre>}
      </details>
    </li>
  )
}
