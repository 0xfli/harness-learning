/**
 * The right column: what the model sees.
 *
 * Empty on purpose. It will show the message list folded out of the log and
 * handed to the provider — the same events as the middle column, projected for
 * a different reader.
 *
 * @module
 */

import type { ReactNode } from 'react'
import { Panel, PanelPlaceholder } from './panel.tsx'

/**
 * The model view column.
 *
 * @returns the column element.
 */
export function ModelViewPanel(): ReactNode {
  return (
    <Panel title="Model view">
      <PanelPlaceholder>
        the messages a model would be sent, derived from the same log. Empty
        until there is a model to send them to.
      </PanelPlaceholder>
    </Panel>
  )
}
