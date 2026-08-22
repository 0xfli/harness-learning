import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLog } from '../src/index.ts'
import { encodeEvent } from '../src/jsonl.ts'
import { openJournal, restoreSession } from '../src/journal.ts'
import type { JournalRepair } from '../src/journal.ts'
import type { SessionEvent } from '../src/index.ts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-journal-'))
  path = join(dir, 'nested', 'session.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Plant a journal file that no `openJournal` has ever written. */
function plantJournalFile(contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/** Record a session and walk away without closing anything, as a kill would. */
function recordAndAbandon(types: readonly string[]): SessionEvent[] {
  const { log, journal } = restoreSession({ path, now: () => 1_700_000_000_000 })
  for (const [index, type] of types.entries()) log.append(type, { n: index })
  const events = [...log.events]
  journal.close()
  return events
}

describe('openJournal', () => {
  it('creates missing directories and starts empty', () => {
    const journal = openJournal({ path })

    expect(journal.events).toEqual([])
    expect(journal.repair).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('')
    journal.close()
  })

  it('refuses to append once closed', () => {
    const journal = openJournal({ path })
    journal.close()

    expect(() => journal.append({ seq: 0, type: 'demo/hello', time: 1, data: {} })).toThrow(
      /closed/,
    )
  })

  it('is idempotent about closing', () => {
    const journal = openJournal({ path })
    journal.close()

    expect(() => journal.close()).not.toThrow()
  })
})

describe('restoreSession', () => {
  it('reads back every event, byte for byte', () => {
    const before = recordAndAbandon(['demo/hello', 'user/message', 'assistant/message'])

    const { log, close } = restoreSession({ path })

    expect(log.events).toEqual(before)
    expect(log.length).toBe(3)
    close()
  })

  it('continues seq from the persisted maximum', () => {
    recordAndAbandon(['demo/hello', 'demo/hello', 'demo/hello'])

    const { log, close } = restoreSession({ path })
    const next = log.append('demo/hello', { n: 3 })

    expect(next.seq).toBe(3)
    // Every seq in the file is still unique and dense, which is the whole
    // claim: a restart is not allowed to hand two facts one number.
    close()
    const seqs = restoreSession({ path }).log.events.map((event) => event.seq)
    expect(seqs).toEqual([0, 1, 2, 3])
  })

  it('survives any number of restarts', () => {
    for (let round = 0; round < 4; round += 1) {
      const { log, close } = restoreSession({ path })
      log.append('demo/hello', { round })
      close()
    }

    const { log, close } = restoreSession({ path })

    expect(log.events.map((event) => event.data['round'])).toEqual([0, 1, 2, 3])
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    close()
  })

  it('persists an event before any other observer hears about it', () => {
    const seen: string[] = []
    const { log, close } = restoreSession({ path })
    log.observe(() => {
      // A client told about seq 0 must be able to find seq 0 after a crash,
      // so the file has to be ahead of the wire, not behind it.
      seen.push(readFileSync(path, 'utf8'))
    })

    const event = log.append('demo/hello', { n: 0 })

    expect(seen[0]).toBe(encodeEvent(event))
    close()
  })

  it('keeps writing multi-byte payloads that survive the round trip', () => {
    const { log, close } = restoreSession({ path })
    log.append('user/message', { text: '你好，世界 🌏' })
    close()

    const restored = restoreSession({ path })

    expect(restored.log.events[0]?.data['text']).toBe('你好，世界 🌏')
    restored.close()
  })

  it('stops observing once closed, so a detached log writes nothing more', () => {
    const { log, close } = restoreSession({ path })
    log.append('demo/hello', { n: 0 })
    close()

    expect(() => log.append('demo/hello', { n: 1 })).not.toThrow()
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

describe('recovering a damaged journal', () => {
  it('drops a partly written trailing line and repairs the file', () => {
    recordAndAbandon(['demo/hello', 'demo/hello'])
    const torn = '{"seq":2,"type":"demo/hel'
    appendFileSync(path, torn)
    const onRepair = vi.fn<(repair: JournalRepair) => void>()

    const { log, journal, close } = restoreSession({ path, onRepair })

    expect(log.length).toBe(2)
    expect(journal.repair).toEqual({
      line: 2,
      bytes: Buffer.byteLength(torn),
      reason: 'partly written line',
    })
    expect(onRepair).toHaveBeenCalledWith(journal.repair)
    close()
  })

  it('leaves the file appendable after a torn line, rather than splicing onto it', () => {
    recordAndAbandon(['demo/hello'])
    appendFileSync(path, '{"seq":1,"type":"demo/')

    const first = restoreSession({ path, onRepair: () => undefined })
    first.log.append('demo/hello', { n: 1 })
    first.close()

    // The repair is what makes this line readable: without the truncation the
    // next append would have continued the torn one and lost both records.
    const { log, close } = restoreSession({ path })
    expect(log.events.map((event) => event.seq)).toEqual([0, 1])
    expect(log.events[1]?.data['n']).toBe(1)
    close()
  })

  it('cuts a torn line at a byte boundary, not a character one', () => {
    const { log, journal } = restoreSession({ path })
    log.append('user/message', { text: '早安' })
    journal.close()
    // Half of a three-byte character: a reader counting characters would
    // truncate in the wrong place and corrupt the line in front of it.
    appendFileSync(path, Buffer.from([0x7b, 0xe6, 0x97]))

    const restored = restoreSession({ path, onRepair: () => undefined })

    expect(restored.log.events[0]?.data['text']).toBe('早安')
    expect(restored.journal.repair?.bytes).toBe(3)
    restored.close()
  })

  it('keeps the prefix in front of an unreadable complete line', () => {
    recordAndAbandon(['demo/hello', 'demo/hello'])
    appendFileSync(path, 'not json at all\n')
    appendFileSync(path, `${JSON.stringify({ seq: 3, type: 'demo/hello', time: 1, data: {} })}\n`)

    const { log, journal, close } = restoreSession({ path, onRepair: () => undefined })

    // Everything after the damage goes too. A log is only ever a prefix, and
    // keeping seq 3 while dropping seq 2 would put a hole in the sequence.
    expect(log.length).toBe(2)
    expect(journal.repair?.reason).toBe('unreadable line')
    close()
  })

  it('stops at a line that claims the wrong seq', () => {
    recordAndAbandon(['demo/hello'])
    appendFileSync(path, `${JSON.stringify({ seq: 7, type: 'demo/hello', time: 1, data: {} })}\n`)

    const { log, journal, close } = restoreSession({ path, onRepair: () => undefined })

    expect(log.length).toBe(1)
    expect(journal.repair?.reason).toBe('line claims seq 7, expected 1')
    close()
  })

  it('warns rather than repairing in silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    plantJournalFile('half a line')

    const { close } = restoreSession({ path })

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('partly written line')
    close()
  })

  it('recovers nothing from a file whose first line is damaged', () => {
    plantJournalFile('\u0000\u0000\u0000\n')

    const { log, journal, close } = restoreSession({ path, onRepair: () => undefined })

    expect(log.events).toEqual([])
    expect(journal.repair?.line).toBe(0)
    close()
  })
})

describe('SessionLog history', () => {
  it('rejects history with a hole in it', () => {
    const history = [
      { seq: 0, type: 'demo/hello', time: 1, data: {} },
      { seq: 2, type: 'demo/hello', time: 2, data: {} },
    ]

    expect(() => new SessionLog({ history })).toThrow(/dense and zero-based/)
  })

  it('rejects history that is not made of events', () => {
    expect(() => new SessionLog({ history: [{ seq: 0 } as unknown as SessionEvent] })).toThrow(
      TypeError,
    )
  })

  it('freezes restored events, so a reloaded fact is as immutable as a fresh one', () => {
    const { log, close } = restoreSession({ path })
    log.append('demo/hello', { nested: { n: 0 } })
    close()

    const restored = restoreSession({ path })
    const event = restored.log.events[0] as SessionEvent

    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data['nested'])).toBe(true)
    restored.close()
  })
})
