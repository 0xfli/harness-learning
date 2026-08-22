/**
 * The middle column: what the human sees.
 *
 * Empty on purpose. It will be a projection of `user/message` and
 * `assistant/chunk` events, and the log contains neither yet — so there is
 * nothing to subscribe to, and nothing here re-renders when an event arrives.
 *
 * @module
 */

import type { ReactNode } from 'react'
import { Panel, PanelPlaceholder } from './panel.tsx'

/**
 * The conversation column.
 *
 * @returns the column element.
 */
export function ConversationPanel(): ReactNode {
  return (
    <Panel title="Conversation">
      <PanelPlaceholder>
        a projection of the message events in the log. There are none yet — and when there are, this
        column will derive them rather than store them.
      </PanelPlaceholder>
    </Panel>
  )
}
