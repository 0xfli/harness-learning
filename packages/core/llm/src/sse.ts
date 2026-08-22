/**
 * Reading Server-Sent Events, as a client.
 *
 * The mirror image of `apps/dev-server/src/sse.ts`, which writes this format
 * for the browser. Nothing is shared between them on purpose: a parser is
 * defensive about input it did not produce, and a serialiser is not.
 *
 * The parsing rules that actually bite, all of which a naive
 * `split('\n\n')` gets wrong:
 *
 * - A frame ends at a blank line, and lines may end with `\n`, `\r\n` or a
 *   bare `\r`.
 * - A frame may carry several `data:` lines, joined with a newline.
 * - One `read()` is not one frame. Frames split across reads, and a multi-byte
 *   character splits across reads too — which is why the decoder is
 *   incremental rather than one `toString` per chunk.
 *
 * @module
 */

/** Bytes arriving from a provider, however the runtime hands them over. */
export type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

/**
 * Turn a stream of bytes into the `data` payload of each SSE frame.
 *
 * Comment frames (`: keep-alive`) and fields other than `data` are dropped:
 * a chat-completions stream carries everything in `data`, and a parser that
 * invents meaning for the rest would be guessing.
 *
 * @param source - the response body.
 * @returns each frame's `data`, in order, with no trailing newline.
 */
export async function* sseDataFrames(source: ByteSource): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of toByteIterable(source)) {
    buffer += decoder.decode(bytes, { stream: true })

    let boundary = findFrameEnd(buffer)
    while (boundary !== undefined) {
      const frame = buffer.slice(0, boundary.start)
      buffer = buffer.slice(boundary.end)
      const data = dataOf(frame)
      if (data !== undefined) yield data
      boundary = findFrameEnd(buffer)
    }
  }

  // Flush whatever the decoder was holding, then take the last frame even
  // though it was never terminated. A provider that closes the socket after
  // its final frame without a trailing blank line is common enough that
  // dropping that frame would lose the finish reason.
  buffer += decoder.decode()
  const data = dataOf(buffer)
  if (data !== undefined) yield data
}

/** Where the first blank line sits, and where the next frame starts after it. */
function findFrameEnd(buffer: string): { start: number; end: number } | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const first = terminatorLength(buffer, index)
    if (first === 0) continue
    const second = terminatorLength(buffer, index + first)
    if (second === 0) {
      // One terminator is a line break, not a frame boundary. Step over the
      // whole of it — a `\r\n` skipped one character at a time would let the
      // `\n` pair up with the next line's `\r` and split a frame in half.
      index += first - 1
      continue
    }
    return { start: index, end: index + first + second }
  }
  return undefined
}

/**
 * The length of the line terminator at `index`.
 *
 * @param buffer - the text being scanned.
 * @param index - where to look.
 * @returns 2 for `\r\n`, 1 for a lone `\r` or `\n`, 0 for anything else.
 */
function terminatorLength(buffer: string, index: number): number {
  const character = buffer[index]
  if (character === '\r') return buffer[index + 1] === '\n' ? 2 : 1
  if (character === '\n') return 1
  return 0
}

/**
 * The `data` of one frame.
 *
 * @param frame - the frame's text, without its terminating blank line.
 * @returns the joined `data` lines, or `undefined` when the frame carried none.
 */
function dataOf(frame: string): string | undefined {
  let data: string | undefined

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') continue
    // A single leading space after the colon is part of the syntax, not the
    // value. Any further spaces are the value's own.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    data = data === undefined ? value : `${data}\n${value}`
  }

  return data
}

/**
 * Adapt a web `ReadableStream` to `for await`, which not every runtime does.
 *
 * Node's `ReadableStream` is async-iterable and its types say so, so this is
 * a runtime check rather than a type-level one — the fallback exists for
 * browsers, where the same type is not iterable at all.
 */
function toByteIterable(source: ByteSource): AsyncIterable<Uint8Array> {
  const iterable = source as AsyncIterable<Uint8Array>
  if (typeof iterable[Symbol.asyncIterator] === 'function') return iterable
  const stream = source as ReadableStream<Uint8Array>
  return (async function* read(): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) yield value
      }
    } finally {
      reader.releaseLock()
    }
  })()
}
