/**
 * The log, written down.
 *
 * A journal is one file holding one session: every event that has been
 * committed, in `seq` order, one JSONL line each, appended as it commits. With
 * `session-store.ts` it is all that `@harness/session` knows about
 * filesystems, which is why the two live behind entry points of their own —
 * the browser half of this codebase imports the log's vocabulary and must
 * never pull in `node:fs`.
 *
 * Three rules do all the work:
 *
 * 1. **A journal is only ever a prefix.** Recovery stops at the first line it
 *    cannot vouch for and truncates the file there. A torn trailing line from
 *    a hard kill is the ordinary case, not an error: the bytes after the last
 *    newline are a record that was still being written, and a record that was
 *    still being written never happened.
 * 2. **Durable before broadcast.** The journal is the first observer attached
 *    to the log, so an event is on disk before any client hears its `seq` —
 *    the same argument as commit-before-broadcast, one layer down.
 * 3. **The first append makes the file.** Opening a journal reads; it does not
 *    create. A session nobody said anything in has no events, and a session
 *    with no events never happened — it must not leave a nought-byte file for
 *    the session store to list. See `docs/adr/0009-a-run-starts-a-session.md`.
 *
 * @module @harness/session/journal
 */

import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { SessionLog } from './index.ts'
import type { SessionLogOptions } from './index.ts'
import { decodeEvent, encodeEvent } from './jsonl.ts'
import type { SessionEvent } from './types.ts'

const NEWLINE = 0x0a

/** What recovery threw away, and why. */
export interface JournalRepair {
  /** Zero-based index of the first line that could not be vouched for. */
  readonly line: number
  /** Bytes discarded from the end of the file. */
  readonly bytes: number
  /** Human-readable cause, for a log line nobody should have to decode. */
  readonly reason: string
}

/** How to open a journal. */
export interface JournalOptions {
  /**
   * File to read and append to. Neither it nor its parent directories have to
   * exist: they are created by the first append, not by opening.
   */
  readonly path: string
  /**
   * Told when recovery had to discard a damaged tail. Defaults to
   * `console.warn`, because losing bytes silently is how a corrupt journal
   * becomes a mystery a week later.
   */
  readonly onRepair?: (repair: JournalRepair) => void
}

/** What a journal file holds, as far as it can be vouched for. */
export interface JournalContents {
  /** Events read back, in `seq` order. A prefix of the log. */
  readonly events: readonly SessionEvent[]
  /** The damage recovery would have to repair, when the tail is unreadable. */
  readonly repair: JournalRepair | undefined
}

/** An open journal: what it recovered, and a way to add to it. */
export interface SessionJournal {
  readonly path: string
  /** Events recovered at open time, in `seq` order. A prefix of the log. */
  readonly events: readonly SessionEvent[]
  /** The repair recovery performed, when the tail was damaged. */
  readonly repair: JournalRepair | undefined
  /**
   * Write one committed event as the next line.
   *
   * Synchronous, so the call returns only once the bytes are with the
   * operating system. That is what makes a killed process — as opposed to a
   * lost machine — a non-event: the page cache outlives the process.
   *
   * The first call is also what creates the file and any missing directory
   * above it, so a journal that is never appended to leaves nothing behind.
   *
   * @param event - the event to persist.
   */
  append(event: SessionEvent): void
  /** Close the file. Further appends throw. */
  close(): void
}

/**
 * Read a journal file without opening, creating, or repairing it.
 *
 * The read-only half of recovery: it stops at the first line it cannot vouch
 * for and reports the damage instead of truncating it away. Listing what is on
 * disk must not rewrite it — a session store summarises every file it can see,
 * and a summary is a projection, not an edit.
 *
 * @param path - the file to read. A missing file is an empty journal.
 * @returns the events read back, and the damage found after them.
 */
export function readJournal(path: string): JournalContents {
  const { events, repair } = scan(readBytes(path))
  return { events: Object.freeze(events), repair }
}

/**
 * Open a journal, recovering whatever is already in it.
 *
 * @param options - where the file lives and who hears about a repair.
 * @returns the open journal, with `events` already read back.
 */
export function openJournal(options: JournalOptions): SessionJournal {
  const { path } = options
  const onRepair =
    options.onRepair ??
    ((repair: JournalRepair) => {
      console.warn(
        `session journal ${path}: discarded ${repair.bytes} byte(s) from line ${repair.line} (${repair.reason})`,
      )
    })

  const { events, valid, repair } = scan(readBytes(path))
  if (repair !== undefined) {
    // Truncating is the point, not tidiness: the next append would otherwise
    // continue the half-written line and produce one corrupt record where
    // there were two, taking a readable prefix down with it.
    truncate(path, valid)
    onRepair(repair)
  }

  /** Opened by the first append, so an unused journal leaves no file. */
  let fd: number | undefined
  let closed = false

  return {
    path,
    events: Object.freeze(events),
    repair,
    append(event: SessionEvent): void {
      if (closed) throw new Error(`session journal ${path} is closed`)
      if (fd === undefined) {
        mkdirSync(dirname(path), { recursive: true })
        // "a" pins every write to the end of the file, so two writers
        // interleave whole lines rather than overwriting each other's.
        fd = openSync(path, 'a')
      }
      writeSync(fd, encodeEvent(event))
    },
    close(): void {
      if (closed) return
      closed = true
      if (fd !== undefined) closeSync(fd)
    },
  }
}

/** A restored session: the log, and the file it will keep writing to. */
export interface RestoredSession {
  readonly log: SessionLog
  readonly journal: SessionJournal
  /** Detach the journal from the log and close the file. */
  close(): void
}

/** How to restore a session. */
export interface RestoreOptions extends JournalOptions, Omit<SessionLogOptions, 'history'> {}

/**
 * Read a session back off disk and keep writing to it.
 *
 * The whole of restoring a session, because history is the log and every other
 * view of it — the conversation, the request, the panels — is derived again
 * from these same events. There is no second thing to rebuild, and no snapshot
 * to migrate: see `docs/adr/0007-the-log-is-the-file.md`.
 *
 * @param options - the journal's path, plus any `SessionLog` options.
 * @returns the restored log, the journal behind it, and a shutdown hook.
 */
export function restoreSession(options: RestoreOptions): RestoredSession {
  const { path, onRepair, ...logOptions } = options
  const journal = openJournal(onRepair === undefined ? { path } : { path, onRepair })
  const log = new SessionLog({ ...logOptions, history: journal.events })

  // Attached before anything else can subscribe, so the journal is the first
  // observer the log dispatches to: on disk before on the wire.
  const unobserve = log.observe((event) => journal.append(event))

  return {
    log,
    journal,
    close(): void {
      unobserve()
      journal.close()
    },
  }
}

/**
 * Read every line we can vouch for, and say where to stop.
 *
 * Works on bytes rather than on a decoded string, because a truncation offset
 * has to be a byte offset — one multi-byte character in a payload and a
 * character count cuts a record in the wrong place.
 */
function scan(buffer: Buffer): {
  events: SessionEvent[]
  valid: number
  repair: JournalRepair | undefined
} {
  const size = buffer.byteLength
  const events: SessionEvent[] = []
  let start = 0

  while (start < size) {
    const end = buffer.indexOf(NEWLINE, start)
    if (end === -1) {
      // No terminator: these bytes are a line the writer never finished.
      return {
        events,
        valid: start,
        repair: { line: events.length, bytes: size - start, reason: 'partly written line' },
      }
    }

    const event = decodeEvent(buffer.toString('utf8', start, end))
    if (event === undefined) {
      return {
        events,
        valid: start,
        repair: { line: events.length, bytes: size - start, reason: 'unreadable line' },
      }
    }
    if (event.seq !== events.length) {
      // A journal is a sequence, so a line that claims someone else's position
      // means the file and the log have already disagreed. Keep the prefix
      // that still holds and stop.
      return {
        events,
        valid: start,
        repair: {
          line: events.length,
          bytes: size - start,
          reason: `line claims seq ${event.seq}, expected ${events.length}`,
        },
      }
    }

    events.push(event)
    start = end + 1
  }

  return { events, valid: size, repair: undefined }
}

/** Every byte of a journal file. A file that is not there yet holds none. */
function readBytes(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

/** Cut a damaged tail off, leaving the prefix that still holds. */
function truncate(path: string, valid: number): void {
  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, valid)
  } finally {
    closeSync(fd)
  }
}
