/**
 * The log, written down.
 *
 * A journal is one file holding one session: every event that has been
 * committed, in `seq` order, one JSONL line each, appended as it commits. It
 * is the only part of `@harness/session` that knows a filesystem exists, which
 * is why it lives behind its own entry point — the browser half of this
 * codebase imports the log's vocabulary and must never pull in `node:fs`.
 *
 * Two rules do all the work:
 *
 * 1. **A journal is only ever a prefix.** Recovery stops at the first line it
 *    cannot vouch for and truncates the file there. A torn trailing line from
 *    a hard kill is the ordinary case, not an error: the bytes after the last
 *    newline are a record that was still being written, and a record that was
 *    still being written never happened.
 * 2. **Durable before broadcast.** The journal is the first observer attached
 *    to the log, so an event is on disk before any client hears its `seq` —
 *    the same argument as commit-before-broadcast, one layer down.
 *
 * @module @harness/session/journal
 */

import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs'
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
  /** File to read and append to. Missing parent directories are created. */
  readonly path: string
  /**
   * Told when recovery had to discard a damaged tail. Defaults to
   * `console.warn`, because losing bytes silently is how a corrupt journal
   * becomes a mystery a week later.
   */
  readonly onRepair?: (repair: JournalRepair) => void
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
   * @param event - the event to persist.
   */
  append(event: SessionEvent): void
  /** Close the file. Further appends throw. */
  close(): void
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

  mkdirSync(dirname(path), { recursive: true })
  // "a+" both creates the file and pins every write to the end of it, so two
  // writers interleave whole lines rather than overwriting each other's.
  const fd = openSync(path, 'a+')
  let closed = false

  try {
    const { events, valid, repair } = recover(fd)
    if (repair !== undefined) {
      // Truncating is the point, not tidiness: the next append would otherwise
      // continue the half-written line and produce one corrupt record where
      // there were two, taking a readable prefix down with it.
      ftruncateSync(fd, valid)
      onRepair(repair)
    }

    return {
      path,
      events: Object.freeze(events),
      repair,
      append(event: SessionEvent): void {
        if (closed) throw new Error(`session journal ${path} is closed`)
        writeSync(fd, encodeEvent(event))
      },
      close(): void {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  } catch (error) {
    closeSync(fd)
    throw error
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
function recover(fd: number): {
  events: SessionEvent[]
  valid: number
  repair: JournalRepair | undefined
} {
  const size = fstatSync(fd).size
  const buffer = Buffer.allocUnsafe(size)
  if (size > 0) readSync(fd, buffer, 0, size, 0)

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
