/**
 * The HTTP front door: an SSE feed of a session log, a way to append to it,
 * and a way to say something to the model. There is no UI for the last one —
 * `curl` is the demo, and the browser is the audience.
 *
 * The server serves a *store* rather than a log. Every route that touches
 * events takes a `session` id and opens it on demand; a request that names
 * none gets the **current session**, which is the one this run started. That
 * is the whole of "load a previous session": ask for it by name. See
 * `docs/adr/0009-a-run-starts-a-session.md`.
 *
 * @module
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isSessionId } from '@harness/session'
import type { JsonObject, OpenSession, SessionLog, SessionStore } from '@harness/session'
import { createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter } from '@harness/llm'
import { recordExchange } from '@harness/exchange'
import { createMemorySessionStore } from './memory-sessions.ts'
import { streamSessionLog } from './sse.ts'

/** How to build the server. */
export interface HarnessServerOptions {
  /**
   * Where sessions are kept. Defaults to a store that keeps them in memory,
   * so a server started with nowhere to write still runs — and forgets.
   */
  readonly sessions?: SessionStore
  /**
   * The session a request that names none talks to. Defaults to a new one,
   * started the first time anybody asks: a run that is never used leaves no
   * session behind.
   */
  readonly currentId?: string
  /** The model behind `POST /messages`. Defaults to a scripted one. */
  readonly adapter?: ModelAdapter
  /** Heartbeat interval for SSE connections, in milliseconds. */
  readonly heartbeatMs?: number
}

/** A running-capable server plus the sessions it serves. */
export interface HarnessServer {
  readonly sessions: SessionStore
  /** The session a request that names none talks to. Started on first read. */
  readonly current: OpenSession
  /** Shorthand for `current.log` — the log a bare `/events` streams. */
  readonly log: SessionLog
  readonly adapter: ModelAdapter
  readonly server: Server
  /** Ends every open stream, closes every open session, then stops listening. */
  close(): Promise<void>
}

/** Largest accepted `POST /events` body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Longest accepted client-supplied message id. A UUID is 36. */
const MAX_ID_LENGTH = 128

const USAGE = `harness-learning session log

Every route below takes an optional ?session=<id>. Without one you get this
run's session — a fresh one, so starting the harness never continues a
conversation you did not ask for.

  GET  /sessions      Every session on the shelf, most recently active first,
                      plus the id of this run's.
  POST /sessions      Start a new session and make it this run's.
  GET  /sessions/<id> One session's summary.
  GET  /events        Server-Sent Events feed: full history, then live events.
                      Send Last-Event-ID to resume without duplicates.
  GET  /events.json   The same history as a plain JSON array.
  POST /events        Append one event. Body: {"type": "demo/hello", "data": {}}
  POST /messages      Say something to the model. Body: {"text": "hello"}
                      Optionally name the exchange: {"text": "hi", "id": "..."}
                      — every event of it carries that id, and a reused one is
                      refused with 409.
                      Records user/message, one assistant/chunk per delta,
                      assistant/usage, then a single assistant/message.
  GET  /health        Liveness probe.

Try it:

  curl -N http://localhost:8787/events
  curl -X POST http://localhost:8787/messages \\
    -H 'content-type: application/json' \\
    -d '{"text":"hello"}'
  curl -s http://localhost:8787/sessions
  curl -N 'http://localhost:8787/events?session=20260823-074139-k3f9'
`

/**
 * Build the HTTP server around a store of sessions.
 *
 * @param options - where sessions live, which one is current, and SSE tuning.
 * @returns the store, the unlistened server, and a shutdown hook.
 */
export function createHarnessServer(options: HarnessServerOptions = {}): HarnessServer {
  const sessions = options.sessions ?? createMemorySessionStore()
  const adapter = options.adapter ?? createScriptedAdapter()
  const openStreams = new Set<() => void>()

  /**
   * This run's session, started the moment something needs one.
   *
   * Lazily, because a harness that created a session at boot would leave a
   * trail of empty conversations behind every restart of a watch process.
   */
  let currentId: string | undefined = options.currentId
  const current = (): OpenSession => {
    const session = currentId === undefined ? sessions.create() : sessions.open(currentId)
    currentId = session.id
    return session
  }

  /** Which session a request is about, or the refusal to guess. */
  type Resolved =
    | { readonly session: OpenSession }
    | { readonly status: number; readonly error: string }

  const sessionFor = (url: URL): Resolved => {
    const id = url.searchParams.get('session')
    if (id === null || id.length === 0) return { session: current() }
    if (!isSessionId(id)) return { status: 400, error: `"${id}" is not a session id` }
    // Opening an unknown id would start a session named after a typo, and the
    // caller would talk to an empty log wondering where the conversation went.
    if (!sessions.has(id)) return { status: 404, error: `no session "${id}"` }
    return { session: sessions.open(id) }
  }

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

    // `GET /sessions/<id>` is the one route with something in its path, and a
    // router for a single pattern would be a router nobody can read.
    const named = /^GET \/sessions\/(?<id>[^/]+)$/.exec(route)
    if (named?.groups?.['id'] !== undefined) {
      const id = decodeURIComponent(named.groups['id'])
      const summary = isSessionId(id) ? sessions.summarise(id) : undefined
      if (summary === undefined) sendJson(res, 404, { error: `no session "${id}"` })
      else sendJson(res, 200, summary)
      return
    }

    switch (route) {
      case 'GET /':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(USAGE)
        return

      case 'GET /health':
        sendJson(res, 200, { ok: true, current: current().id, events: current().log.length })
        return

      case 'GET /sessions':
        // Reading the list is also what starts this run's session, so the
        // answer always names one the caller may talk to.
        sendJson(res, 200, { current: current().id, sessions: sessions.list() })
        return

      case 'POST /sessions': {
        const session = sessions.create()
        currentId = session.id
        sendJson(res, 201, {
          current: session.id,
          session: sessions.summarise(session.id) ?? null,
        })
        return
      }

      case 'GET /events.json': {
        const resolved = sessionFor(url)
        if ('error' in resolved) {
          sendJson(res, resolved.status, { error: resolved.error })
          return
        }
        sendJson(res, 200, resolved.session.log.events)
        return
      }

      case 'GET /events': {
        const resolved = sessionFor(url)
        if ('error' in resolved) {
          sendJson(res, resolved.status, { error: resolved.error })
          return
        }
        const heartbeat = options.heartbeatMs
        const close = streamSessionLog(
          resolved.session.log,
          req,
          res,
          heartbeat === undefined ? {} : { heartbeatMs: heartbeat },
        )
        openStreams.add(close)
        res.on('close', () => openStreams.delete(close))
        return
      }

      case 'POST /events': {
        const resolved = sessionFor(url)
        if ('error' in resolved) {
          sendJson(res, resolved.status, { error: resolved.error })
          return
        }
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
          const event = resolved.session.log.append(type, (data ?? {}) as JsonObject)
          sendJson(res, 201, event)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      case 'POST /messages': {
        const resolved = sessionFor(url)
        if ('error' in resolved) {
          sendJson(res, resolved.status, { error: resolved.error })
          return
        }
        const log = resolved.session.log
        const body = await readJsonBody(req)
        if (body === undefined || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body must be a JSON object' })
          return
        }
        const { text, id } = body as { text?: unknown; id?: unknown }
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendJson(res, 400, { error: '"text" must be a non-empty string' })
          return
        }
        if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
          sendJson(res, 400, { error: '"id" must be a non-empty string when given' })
          return
        }
        if (typeof id === 'string' && id.length > MAX_ID_LENGTH) {
          sendJson(res, 400, { error: `"id" must be at most ${MAX_ID_LENGTH} characters` })
          return
        }
        if (typeof id === 'string' && log.events.some((event) => event.data['id'] === id)) {
          // Two exchanges under one id would fold into one turn in every
          // reader downstream, and the log cannot un-append the second.
          sendJson(res, 409, { error: `id "${id}" is already in the log` })
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
            // Letting the caller name the exchange is what lets a browser show
            // the message it just sent and recognise it when it comes back
            // down the feed, rather than guessing by text. See ADR-0005.
            ...(typeof id === 'string' ? { newId: () => id } : {}),
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
    sessions,
    get current(): OpenSession {
      return current()
    },
    get log(): SessionLog {
      return current().log
    },
    adapter,
    server,
    close: async () => {
      for (const closeStream of openStreams) closeStream()
      openStreams.clear()
      // Journals last: a stream still holding a log would otherwise observe a
      // session whose file has already been closed under it.
      sessions.close()
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
 * Nothing calls this at boot any more: seeding is what a single, always-there
 * log could get away with, and a new session that started life with three
 * invented facts would be a file on the shelf nobody asked for.
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
