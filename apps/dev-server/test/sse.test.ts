import { describe, expect, it } from 'vitest'
import { SessionLog } from '@harness/session'
import { formatSseFrame, resumeSeqFrom } from '../src/sse.ts'

describe('formatSseFrame', () => {
  it('puts seq in the id field and the whole event in data', () => {
    const log = new SessionLog({ now: () => 123 })
    const event = log.append('demo/hello', { message: 'hi' })

    expect(formatSseFrame(event)).toBe(
      `id: 0\ndata: {"seq":0,"type":"demo/hello","time":123,"data":{"message":"hi"}}\n\n`,
    )
  })

  it('keeps a payload with newlines on one data line', () => {
    const log = new SessionLog({ now: () => 0 })
    const event = log.append('demo/hello', { message: 'line one\nline two' })

    const frame = formatSseFrame(event)

    expect(frame.split('\n')).toHaveLength(4)
    expect(frame).toContain('line one\\nline two')
  })
})

describe('resumeSeqFrom', () => {
  it('resumes just after the last id the client saw', () => {
    expect(resumeSeqFrom('0')).toBe(1)
    expect(resumeSeqFrom('41')).toBe(42)
  })

  it('starts from the beginning without a usable header', () => {
    expect(resumeSeqFrom(undefined)).toBe(0)
    expect(resumeSeqFrom('')).toBe(0)
    expect(resumeSeqFrom('nope')).toBe(0)
    expect(resumeSeqFrom('-3')).toBe(0)
    expect(resumeSeqFrom('1.5')).toBe(0)
  })

  it('reads the first value when the header repeats', () => {
    expect(resumeSeqFrom(['2', '9'])).toBe(3)
  })
})
