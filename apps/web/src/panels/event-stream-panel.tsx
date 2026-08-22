/**
 * The left column: the log itself, one line per event.
 *
 * This is the only panel that subscribes to events, which is what makes an
 * arriving event re-render this column and nothing else.
 *
 * @module
 */

import type { ReactNode } from 'react'
import type { SessionEvent } from '@harness/session'
import { formatClock, formatData } from '../format.ts'
import { useSessionEvents } from '../use-session.ts'
import { Panel, PanelPlaceholder } from './panel.tsx'

/**
 * Every event in the log, oldest first.
 *
 * @returns the event stream column.
 */
export function EventStreamPanel(): ReactNode {
  const events = useSessionEvents()

  return (
    <Panel title="Event stream" note={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}>
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

function EventRow({ event }: EventRowProps): ReactNode {
  const data = formatData(event.data)
  return (
    <li className="event-row" data-seq={event.seq} data-type={event.type}>
      <span className="event-seq">{event.seq}</span>
      <time className="event-time" dateTime={new Date(event.time).toISOString()}>
        {formatClock(event.time)}
      </time>
      <span className="event-type">{event.type}</span>
      <span className="event-data">{data}</span>
    </li>
  )
}
