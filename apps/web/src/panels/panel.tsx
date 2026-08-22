/**
 * One column of the inspector: a heading, a note, and a scrolling body.
 *
 * @module
 */

import type { ReactNode } from 'react'

/** Props for {@link Panel}. */
export interface PanelProps {
  /** Column heading, also its accessible name. */
  readonly title: string
  /** Small right-aligned note, e.g. a count. */
  readonly note?: string | undefined
  readonly children: ReactNode
}

/**
 * Column chrome.
 *
 * @param props - heading, note, and body.
 * @returns the column element.
 */
export function Panel({ title, note, children }: PanelProps): ReactNode {
  return (
    <section className="panel" aria-label={title}>
      <header className="panel-header">
        <h2 className="panel-title">{title}</h2>
        {note === undefined ? null : <span className="panel-note">{note}</span>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

/** Props for {@link PanelPlaceholder}. */
export interface PanelPlaceholderProps {
  readonly children: ReactNode
}

/**
 * What a column says when it has nothing to project yet.
 *
 * @param props - the explanation.
 * @returns the placeholder element.
 */
export function PanelPlaceholder({ children }: PanelPlaceholderProps): ReactNode {
  return <p className="panel-placeholder">{children}</p>
}
