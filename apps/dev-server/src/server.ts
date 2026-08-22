/**
 * The HTTP front door: an SSE feed of the session log, a way to append to it,
 * and a way to say something to the model. There is no UI for the last one —
 * `curl` is the demo, and the browser is the audience.
 *
 * @module
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { SessionLog } from '@harness/session'
import type { JsonObject } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter } from '@harness/llm'
import { recordExchange } from '@harness/exchange'
import { streamSessionLog } from './sse.ts'

/** How to build the server. */
export interface HarnessServerOptions {
  /** The log to serve. A fresh one is created when omitted. */
  readonly log?: SessionLog
  /** The model behind `POST /messages`. Defaults to a scripted one. */
  readonly adapter?: ModelAdapter
  /** Heartbeat interval for SSE connections, in milliseconds. */
  readonly heartbeatMs?: number
}

/** A running-capable server plus the log it serves. */
export interface HarnessServer {
  readonly log: SessionLog
  readonly adapter: ModelAdapter
  readonly server: Server
  /** Ends every open stream, then stops accepting connections. */
  close(): Promise<void>
}

/** Largest accepted `POST /events` body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

const USAGE = `harness-learning session log

  GET  /events        Server-Sent Events feed: full history, then live events.
                      Send Last-Event-ID to resume without duplicates.
  GET  /events.json   The same history as a plain JSON array.
  POST /events        Append one event. Body: {"type": "demo/hello", "data": {}}
  POST /messages      Say something to the model. Body: {"text": "hello"}
                      Records user/message, one assistant/chunk per delta,
                      assistant/usage, then a single assistant/message.
  GET  /health        Liveness probe.

Try it:

  curl -N http://localhost:8787/events
  curl -X POST http://localhost:8787/messages \\
    -H 'content-type: application/json' \\
    -d '{"text":"hello"}'
`

/**
 * Build the HTTP server around a session log.
 *
 * @param options - the log to serve and SSE tuning.
 * @returns the log, the unlistened server, and a shutdown hook.
 */
export function createHarnessServer(options: HarnessServerOptions = {}): HarnessServer {
  const log = options.log ?? new SessionLog()
  const adapter = options.adapter ?? createScriptedAdapter()
  const openStreams = new Set<() => void>()

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error('request failed', error)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const route = `${req.method ?? 'GET'} ${url.pathname}`

    switch (route) {
      case 'GET /':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(USAGE)
        return

      case 'GET /health':
        sendJson(res, 200, { ok: true, events: log.length })
        return

      case 'GET /events.json':
        sendJson(res, 200, log.events)
        return

      case 'GET /events': {
        const heartbeat = options.heartbeatMs
        const close = streamSessionLog(
          log,
          req,
          res,
          heartbeat === undefined ? {} : { heartbeatMs: heartbeat },
        )
        openStreams.add(close)
        res.on('close', () => openStreams.delete(close))
        return
      }

      case 'POST /events': {
        const body = await readJsonBody(req)
        if (body === undefined || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body must be a JSON object' })
          return
        }
        const { type, data } = body as { type?: unknown; data?: unknown }
        if (typeof type !== 'string' || type.length === 0) {
          sendJson(res, 400, { error: '"type" must be a non-empty string' })
          return
        }
        try {
          const event = log.append(type, (data ?? {}) as JsonObject)
          sendJson(res, 201, event)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      case 'POST /messages': {
        const body = await readJsonBody(req)
        if (body === undefined || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body must be a JSON object' })
          return
        }
        const { text } = body as { text?: unknown }
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendJson(res, 400, { error: '"text" must be a non-empty string' })
          return
        }

        // A client that hangs up should not keep the provider running; the
        // deltas already recorded stay recorded either way.
        const controller = new AbortController()
        req.on('aborted', () => controller.abort())

        try {
          const result = await recordExchange({
            log,
            adapter,
            text,
            signal: controller.signal,
          })
          sendJson(res, 200, {
            id: result.id,
            text: result.text,
            reason: result.reason,
            chunks: result.chunks,
            usage: result.usage ?? null,
            seq: {
              userMessage: result.userMessage.seq,
              assistantMessage: result.assistantMessage.seq,
            },
          })
        } catch (error) {
          // `error/stream` is already in the log — that is the durable record.
          // This response is only for the caller that is still waiting.
          sendJson(res, 502, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      default:
        sendJson(res, 404, { error: `no route for ${route}` })
    }
  }

  return {
    log,
    adapter,
    server,
    close: async () => {
      for (const closeStream of openStreams) closeStream()
      openStreams.clear()
      // Keep-alive sockets would otherwise hold the close open until they time
      // out. This is a dev server; shutdown should be immediate.
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error !== undefined &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

/**
 * Append a handful of `demo/hello` events so a fresh stream has something to
 * replay. Proof that the pipe works end to end, and nothing more.
 *
 * @param log - the log to seed.
 */
export function seedDemoEvents(log: SessionLog): void {
  log.append('demo/hello', { message: 'the log exists' })
  log.append('demo/hello', { message: 'facts go in, in order' })
  log.append('demo/hello', { message: 'and never come back out' })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}
