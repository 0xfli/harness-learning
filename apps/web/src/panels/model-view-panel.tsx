/**
 * The right column: what the model sees.
 *
 * The same events as the other two columns, folded by `deriveMessages` — the
 * very function the server calls to build a request — and printed as the JSON
 * that goes on the wire. Not a summary of the request and not a preview of it:
 * the request, which is why `test/model-view.test.ts` can compare this column
 * character for character with what a provider was handed.
 *
 * Nothing here is fetched, and nothing here is remembered. While a reply is
 * streaming this column does not move at all — deltas are facts about the
 * process, and the request was settled before the first one arrived — so the
 * middle column typing itself out beside a still right-hand column is the
 * three-way relationship the inspector exists to show.
 *
 * @module
 */

import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import { deriveMessages } from '@harness/exchange'
import { modelViewBlocks } from '../model-view.ts'
import { useSessionEvents } from '../use-session.ts'
import { useTailFollow } from '../use-tail-follow.ts'
import { Panel, PanelPlaceholder } from './panel.tsx'

/**
 * The model view column.
 *
 * @returns the column element.
 */
export function ModelViewPanel(): ReactNode {
  const events = useSessionEvents()
  // Keyed on the snapshot's identity, which changes only when the log grew
  // (ADR-0002). The fold itself is the same one the request is built with;
  // memoising it is a performance decision and nothing more.
  const blocks = useMemo(() => modelViewBlocks(deriveMessages(events)), [events])
  const tail = useTailFollow(blocks.length)

  return (
    <Panel
      title="Model view"
      note={`${blocks.length} ${blocks.length === 1 ? 'message' : 'messages'}`}
      bodyRef={tail.ref}
      onBodyScroll={tail.onScroll}
    >
      {blocks.length === 0 ? (
        <PanelPlaceholder>
          nothing to send yet. What appears here is the request itself — the same events as the
          other two columns, derived from the same log and serialised exactly as a provider receives
          it.
        </PanelPlaceholder>
      ) : (
        <pre className="model-json">
          <span className="model-frame">{'[\n'}</span>
          {blocks.map((block) => (
            <Fragment key={block.index}>
              {block.index === 0 ? null : <span className="model-frame">{',\n'}</span>}
              <span className="model-message" data-role={block.role} data-index={block.index}>
                {block.json}
              </span>
            </Fragment>
          ))}
          <span className="model-frame">{'\n]'}</span>
        </pre>
      )}
    </Panel>
  )
}
