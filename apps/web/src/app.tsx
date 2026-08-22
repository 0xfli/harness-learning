/**
 * The session inspector: three columns over one log.
 *
 * Left is what happened, middle is what the human sees, right is what the
 * model sees. Only the left column has anything to show yet, and all three
 * are projections of the same event array — keeping those three in agreement
 * is the entire job of a harness.
 *
 * @module
 */

import type { ReactNode } from 'react'
import { ConnectionStatus } from './connection-status.tsx'
import { ConversationPanel } from './panels/conversation-panel.tsx'
import { EventStreamPanel } from './panels/event-stream-panel.tsx'
import { ModelViewPanel } from './panels/model-view-panel.tsx'

/**
 * The whole page.
 *
 * Note what this component does not do: it does not read the log. Nothing is
 * threaded through it as props, so an arriving event re-renders the one panel
 * that subscribed to events and nothing else.
 *
 * @returns the inspector element.
 */
export function App(): ReactNode {
  return (
    <div className="inspector">
      <header className="inspector-header">
        <h1 className="inspector-title">session inspector</h1>
        <ConnectionStatus />
      </header>
      <main className="inspector-columns">
        <EventStreamPanel />
        <ConversationPanel />
        <ModelViewPanel />
      </main>
    </div>
  )
}
