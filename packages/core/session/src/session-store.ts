/**
 * A directory of journals, read as a shelf of sessions.
 *
 * One session is one file; the file's name is the session's id. That is the
 * whole mapping, and it is deliberately something a human can operate: `ls`
 * lists the sessions, `mv` renames one, `rm` deletes one, and nothing in here
 * has to be told about it afterwards. There is no index, no manifest and no
 * database — an index would be a second source of truth about a set of logs
 * that already know what they contain.
 *
 * Listing therefore reads every journal it can see and folds each one into a
 * {@link SessionSummary}. That is linear in what is on disk, which is the
 * right trade for a dev harness with tens of sessions and the wrong one for a
 * server with millions. When it stops being the right trade, the answer is a
 * cache in front of these files — never a file that claims to know better than
 * they do.
 *
 * @module @harness/session/store
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { asSessionId, isSessionId, newSessionId, summariseEvents } from './index.ts'
import type { OpenSession, SessionStore, SessionSummary } from './index.ts'
import { readJournal, restoreSession } from './journal.ts'
import type { JournalRepair } from './journal.ts'

/** Extension every journal carries. Also how a session is told from a stray file. */
const SUFFIX = '.jsonl'

/** How to open a store. */
export interface SessionStoreOptions {
  /** Directory the journals live in. Created by the first event written. */
  readonly dir: string
  /** Wall clock, for stamping events and naming new sessions. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Source of the suffix in a new session's id. Defaults to `Math.random`. */
  readonly random?: () => number
  /** Told when opening a session had to repair its journal. */
  readonly onRepair?: (repair: JournalRepair, id: string) => void
}

/**
 * Open a directory of sessions.
 *
 * Nothing is read and nothing is created until something is asked for: the
 * directory itself only appears when a session first records an event.
 *
 * @param options - where the journals live, and the clock they are stamped from.
 * @returns the store.
 */
export function openSessionStore(options: SessionStoreOptions): SessionStore {
  const { dir, now, random, onRepair } = options
  const open = new Map<string, { readonly session: OpenSession; readonly dispose: () => void }>()

  const pathOf = (id: string): string => join(dir, `${asSessionId(id)}${SUFFIX}`)

  const summarise = (id: string): SessionSummary | undefined => {
    const held = open.get(id)
    // An open session is summarised from its log rather than from its file.
    // The two agree — every event is on disk before anyone hears about it —
    // but only one of them is the log.
    if (held !== undefined) return summariseEvents(id, held.session.log.events)
    if (!isSessionId(id) || !existsSync(pathOf(id))) return undefined
    return summariseEvents(id, readJournal(pathOf(id)).events)
  }

  const store: SessionStore = {
    list(): readonly SessionSummary[] {
      const summaries = new Map<string, SessionSummary>()

      for (const id of storedIds(dir)) {
        const summary = summarise(id)
        // A file with nothing readable in it describes no session. Skipping it
        // keeps a journal that was cut down to nothing out of the picker
        // rather than offering an empty conversation to resume.
        if (summary !== undefined && summary.events > 0) summaries.set(id, summary)
      }
      // An open session belongs in the list before it has recorded anything:
      // the session this run started is exactly the one a human is about to
      // type into, and it has no file yet.
      for (const [id, held] of open) summaries.set(id, summariseEvents(id, held.session.log.events))

      return Object.freeze(
        [...summaries.values()].toSorted((left, right) => {
          // Most recently active first, and a session that has not spoken yet
          // is the newest thing there is.
          const order = (right.updatedAt ?? Infinity) - (left.updatedAt ?? Infinity)
          return order !== 0 ? order : right.id.localeCompare(left.id)
        }),
      )
    },

    has(id: string): boolean {
      return open.has(id) || (isSessionId(id) && existsSync(pathOf(id)))
    },

    summarise,

    open(id: string): OpenSession {
      const held = open.get(id)
      if (held !== undefined) return held.session

      const restored = restoreSession({
        path: pathOf(id),
        ...(now === undefined ? {} : { now }),
        ...(onRepair === undefined ? {} : { onRepair: (repair) => onRepair(repair, id) }),
      })

      const session: OpenSession = {
        id,
        log: restored.log,
        close(): void {
          if (open.get(id)?.session !== session) return
          open.delete(id)
          restored.close()
        },
      }
      open.set(id, { session, dispose: restored.close })
      return session
    },

    create(): OpenSession {
      const base = newSessionId({
        ...(now === undefined ? {} : { now }),
        ...(random === undefined ? {} : { random }),
      })
      // A second session started in the same millisecond with the same suffix
      // would open the first one's journal and append to a conversation it has
      // never seen. Cheap to rule out, catastrophic to allow.
      let id = base
      for (let n = 2; store.has(id); n += 1) id = `${base}-${n}`
      return store.open(id)
    },

    close(): void {
      for (const held of open.values()) held.dispose()
      open.clear()
    },
  }

  return store
}

/** Every session id the directory holds a journal for. */
function storedIds(dir: string): readonly string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // No directory yet is no sessions yet — a store is created by its first
    // event, not by being opened.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUFFIX)) continue
    const id = entry.name.slice(0, -SUFFIX.length)
    // A file whose name could not have been written by this store is somebody
    // else's; listing it would offer an id that `open` then refuses.
    if (isSessionId(id)) ids.push(id)
  }
  return ids
}
