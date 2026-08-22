import { describe, expect, it } from 'vitest'
import { sseDataFrames } from '../src/sse.ts'

const encoder = new TextEncoder()

/** Feed the parser a fixed set of byte chunks, however they were split. */
async function parse(chunks: readonly (string | Uint8Array)[]): Promise<string[]> {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk
  }
  const frames: string[] = []
  for await (const data of sseDataFrames(source())) frames.push(data)
  return frames
}

describe('sseDataFrames', () => {
  it('reads one frame per blank line', async () => {
    expect(await parse(['data: one\n\ndata: two\n\n'])).toEqual(['one', 'two'])
  })

  it('strips exactly one space after the colon', async () => {
    expect(await parse(['data:  two spaces\n\n'])).toEqual([' two spaces'])
    expect(await parse(['data:none\n\n'])).toEqual(['none'])
  })

  it('joins several data lines with a newline', async () => {
    expect(await parse(['data: first\ndata: second\n\n'])).toEqual(['first\nsecond'])
  })

  it('keeps an empty data line', async () => {
    expect(await parse(['data:\n\n'])).toEqual([''])
  })

  it('ignores comments and unknown fields', async () => {
    expect(await parse([': keep-alive\n\nevent: ping\nid: 4\ndata: real\n\n'])).toEqual(['real'])
  })

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('accepts %s line endings', async (_label, eol) => {
    expect(await parse([`data: one${eol}${eol}data: two${eol}${eol}`])).toEqual(['one', 'two'])
  })

  it('reassembles a frame split across reads', async () => {
    expect(await parse(['da', 'ta: sp', 'lit\n', '\ndata: next\n\n'])).toEqual(['split', 'next'])
  })

  it('reassembles a multi-byte character split across reads', async () => {
    const bytes = encoder.encode('data: 世界\n\n')
    const cut = 8 // lands inside the first character
    expect(await parse([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(['世界'])
  })

  it('yields a final frame that was never terminated', async () => {
    // Providers hang up after their last frame more often than they send a
    // trailing blank line, and that frame carries the finish reason.
    expect(await parse(['data: one\n\ndata: last'])).toEqual(['one', 'last'])
  })

  it('yields nothing for an empty or comment-only stream', async () => {
    expect(await parse([])).toEqual([])
    expect(await parse([': just a comment\n\n'])).toEqual([])
  })

  it('does not treat a bare CRLF between fields as a frame boundary', async () => {
    expect(await parse(['data: a\r\ndata: b\r\n\r\n'])).toEqual(['a\nb'])
  })

  it('reads a web ReadableStream as well as an async iterable', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: from a stream\n\n'))
        controller.close()
      },
    })

    const frames: string[] = []
    for await (const data of sseDataFrames(stream)) frames.push(data)

    expect(frames).toEqual(['from a stream'])
  })
})
