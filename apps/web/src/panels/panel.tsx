/**
 * One column of the inspector: a heading, a note, and a scrolling body.
 *
 * @module
 */

import type { ReactNode, Ref, UIEventHandler } from 'react'

/** Props for {@link Panel}. */
export interface PanelProps {
  /** Column heading, also its accessible name. */
  readonly title: string
  /** Small right-aligned note, e.g. a count. */
  readonly note?: string | undefined
  /** Attach to the scrolling body, for a column that follows its own tail. */
  readonly bodyRef?: Ref<HTMLDivElement> | undefined
  readonly onBodyScroll?: UIEventHandler<HTMLDivElement> | undefined
  /**
   * Pinned below the body, outside the scroll. For a column that is written
   * to as well as read — the composer must not scroll away with the history.
   */
  readonly footer?: ReactNode | undefined
  readonly children: ReactNode
}

/**
 * Column chrome.
 *
 * @param props - heading, note, body, and anything pinned under it.
 * @returns the column element.
 */
export function Panel({
  title,
  note,
  bodyRef,
  onBodyScroll,
  footer,
  children,
}: PanelProps): ReactNode {
  return (
    <section className="panel" aria-label={title}>
      <header className="panel-header">
        <h2 className="panel-title">{title}</h2>
        {note === undefined ? null : <span className="panel-note">{note}</span>}
      </header>
      <div className="panel-body" ref={bodyRef} onScroll={onBodyScroll}>
        {children}
      </div>
      {footer === undefined ? null : <div className="panel-footer">{footer}</div>}
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
