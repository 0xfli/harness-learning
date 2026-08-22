/**
 * A minimal Server-Sent Events client for tests: enough of the wire format to
 * assert on ordering, and nothing more.
 *
 * @module
 */

import type { SessionEvent } from '@harness/session'

/** One parsed SSE frame that carried a `data` field. */
export interface SseFrame {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

/** An open SSE connection under test. */
export interface SseConnection {
  /** Frames received so far, in arrival order. */
  readonly frames: readonly SseFrame[]
  /** Session events decoded from those frames. */
  events(): SessionEvent[]
  /** Resolve once at least `count` frames have arrived. */
  waitForFrames(count: number, timeoutMs?: number): Promise<void>
  /** Abort the connection. */
  close(): Promise<void>
}

/**
 * Open an SSE connection and start collecting frames in the background.
 *
 * @param url - the stream endpoint.
 * @param headers - extra request headers, e.g. `Last-Event-ID`.
 * @returns the live connection.
 */
export async function connectSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseConnection> {
  const controller = new AbortController()
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  })
  if (!response.ok || response.body === null) {
    throw new Error(`SSE connect failed: ${response.status}`)
  }

  const frames: SseFrame[] = []
  const pump = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = parseFrame(buffer.slice(0, boundary))
          if (frame !== undefined) frames.push(frame)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Aborting mid-stream is how these tests end; it is not a failure.
    }
  })()

  return {
    frames,
    events: () => frames.map((frame) => JSON.parse(frame.data) as SessionEvent),
    waitForFrames: async (count, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs
      while (frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} SSE frames, saw ${frames.length}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: async () => {
      controller.abort()
      await pump
    },
  }
}

/**
 * Parse one raw frame body.
 *
 * @param raw - the text between two blank lines.
 * @returns the frame, or `undefined` for comment-only or data-less frames
 *   such as heartbeats and the `retry:` hint.
 */
function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []

  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  if (data.length === 0) return undefined
  return { id, event, data: data.join('\n') }
}
