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
import { ThemeToggle } from './theme-toggle.tsx'

/**
 * The whole page.
 *
 * Note what this component does not do: it does not read the log, and it does
 * not hold the colour scheme either. Nothing is threaded through it as props,
 * so an arriving event re-renders the one panel that subscribed to events, and
 * changing the scheme re-renders only the toggle.
 *
 * @returns the inspector element.
 */
export function App(): ReactNode {
  return (
    <div className="inspector">
      <header className="inspector-header">
        <div className="inspector-brand">
          {/* Three bars on an accent tile: the page in miniature, drawn by the
              stylesheet so the palette re-skins it along with everything
              else. */}
          <span className="inspector-mark" aria-hidden="true" />
          <div className="inspector-identity">
            <h1 className="inspector-title">Session inspector</h1>
            <p className="inspector-subtitle">three projections of one log</p>
          </div>
        </div>
        <ConnectionStatus />
        <ThemeToggle />
      </header>
      <main className="inspector-columns">
        <EventStreamPanel />
        <ConversationPanel />
        <ModelViewPanel />
      </main>
    </div>
  )
}
