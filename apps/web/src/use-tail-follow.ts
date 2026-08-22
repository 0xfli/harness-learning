/**
 * Following the tail of a growing list without fighting the reader.
 *
 * A log view that always jumps to the bottom is unusable the moment you try to
 * read history; one that never does is unusable while anything is happening.
 * The rule is the one every terminal already uses: follow while the reader is
 * at the bottom, stop the instant they scroll away, resume when they come
 * back.
 *
 * @module
 */

import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** What a scrolling container needs to follow its own tail. */
export interface TailFollow {
  /** Attach to the scrolling element. */
  readonly ref: RefObject<HTMLDivElement | null>
  /** Attach to that element's `onScroll`. */
  readonly onScroll: () => void
}

/**
 * How close to the bottom still counts as "at the bottom", in pixels. Enough
 * to survive a partly visible row and sub-pixel rounding.
 */
const PINNED_SLACK = 24

/**
 * Keep a scrolling container pinned to its newest content.
 *
 * @param revision - changes whenever the content grew; the scroll is applied
 *   after React has committed that growth.
 * @returns the ref and scroll handler to spread onto the container.
 */
export function useTailFollow(revision: number): TailFollow {
  const ref = useRef<HTMLDivElement | null>(null)
  // Whether the reader is at the bottom. A ref rather than state on purpose:
  // scroll position is not something the page renders, and re-rendering the
  // list to remember where it was scrolled would be circular.
  const pinned = useRef(true)
  // The revision this hook has already scrolled for. Starts at a value no
  // caller can pass, so a container that mounts with content already in it
  // opens at the bottom.
  const seen = useRef(-1)

  const onScroll = useCallback(() => {
    const container = ref.current
    if (container === null) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    pinned.current = distance <= PINNED_SLACK
  }, [])

  // Layout, not passive: the jump happens in the same frame as the new row, so
  // the list never visibly lurches.
  useLayoutEffect(() => {
    const container = ref.current
    // Only growth moves the view. An effect that runs for any other reason —
    // a remount, StrictMode's double invocation — must not yank the reader
    // back down.
    if (container === null || revision === seen.current) return
    seen.current = revision
    if (!pinned.current) return
    container.scrollTop = container.scrollHeight
  }, [revision])

  return { ref, onScroll }
}
