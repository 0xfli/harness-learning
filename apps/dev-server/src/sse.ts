/**
 * Server-Sent Events transport for a {@link SessionLog}.
 *
 * One connection is one cursor over the log. Everything else — history replay,
 * live tail, reconnect resume — falls out of moving that cursor forward.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionEvent, SessionLog } from '@harness/session'

/** Tuning for one SSE connection. */
export interface SseStreamOptions {
  /**
   * Comment frame interval, in milliseconds. Keeps idle connections alive
   * through proxies that time out silent sockets. Zero disables it.
   */
  readonly heartbeatMs?: number
  /** Reconnect delay advertised to `EventSource`, in milliseconds. */
  readonly retryMs?: number
}

const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_RETRY_MS = 1_000

/**
 * Render one event as an SSE frame.
 *
 * The frame carries the whole event as its `data` payload and uses `seq` as
 * the SSE `id`, which is what makes `Last-Event-ID` resume work. There is
 * deliberately no `event:` field: naming the frame after the harness event
 * type would stop a browser's generic `onmessage` handler from firing, and the
 * type is already in the payload.
 *
 * @param event - the committed event to render.
 * @returns a complete frame, terminated by a blank line.
 */
export function formatSseFrame(event: SessionEvent): string {
  // JSON.stringify never emits a raw newline, so a single `data:` line is safe.
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Read the resume point out of a reconnecting client's request.
 *
 * @param header - the `Last-Event-ID` header value, if any.
 * @returns the first `seq` the client still needs; `0` when it needs everything.
 */
export function resumeSeqFrom(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined || raw.trim().length === 0) return 0
  const lastSeq = Number(raw)
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) return 0
  return lastSeq + 1
}

/**
 * Attach `res` to `log` as an SSE feed: full history first, then live events,
 * in `seq` order with no gaps and no duplicates.
 *
 * The connection keeps a `cursor` — the next `seq` it owes the client — and
 * every flush drains `log.since(cursor)`. Because the log is the single source
 * of truth for what to send, and the cursor is the single source of truth for
 * what has been sent, subscribing and replaying history cannot race: whichever
 * happens first, the second one finds nothing left to do.
 *
 * @param log - the log to stream.
 * @param req - the client request, read for `Last-Event-ID`.
 * @param res - the response to stream into; owned by this function from here on.
 * @param options - heartbeat and reconnect tuning.
 * @returns a function that ends the stream early, e.g. on server shutdown.
 */
export function streamSessionLog(
  log: SessionLog,
  req: IncomingMessage,
  res: ServerResponse,
  options: SseStreamOptions = {},
): () => void {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tell nginx and friends not to buffer a stream that only makes sense live.
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()

  let cursor = resumeSeqFrom(req.headers['last-event-id'])
  let closed = false

  const flush = (): void => {
    if (closed) return
    for (const event of log.since(cursor)) {
      // Backpressure is ignored: a client too slow to drain the socket buffers
      // in memory. Acceptable for a dev server, not for a real one.
      res.write(formatSseFrame(event))
      cursor = event.seq + 1
    }
  }

  res.write(`retry: ${retryMs}\n\n`)

  const unobserve = log.observe(flush)
  flush()

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!closed) res.write(': heartbeat\n\n')
        }, heartbeatMs)
      : undefined
  heartbeat?.unref()

  const close = (): void => {
    if (closed) return
    closed = true
    unobserve()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    // `close` also runs when the client hung up, in which case the response is
    // already finished and ending it again would raise.
    if (!res.writableEnded) res.end()
  }

  res.on('close', close)
  return close
}
