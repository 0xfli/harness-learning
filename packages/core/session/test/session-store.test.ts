import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeEvent } from '../src/jsonl.ts'
import { openSessionStore } from '../src/session-store.ts'
import type { SessionStore } from '../src/index.ts'

let root: string
let dir: string
let store: SessionStore

/** A clock a test can move, so `updatedAt` is a fact rather than a race. */
let clock = 1_700_000_000_000

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-'))
  // One level down, so the store has to create the directory it was given.
  dir = join(root, 'sessions')
  clock = 1_700_000_000_000
  store = openSessionStore({ dir, now: () => clock })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** Plant a journal no store has ever written. */
function plant(name: string, contents: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), contents)
}

/** One journal line, as the log would have written it. */
function line(seq: number, type: string, data: Record<string, unknown> = {}): string {
  return encodeEvent({ seq, type, time: clock, data: data as never })
}

describe('a store with nothing in it', () => {
  it('lists nothing and creates nothing', () => {
    expect(store.list()).toEqual([])
    // Opening a store is not an act of writing. A harness that made a
    // directory on boot would leave one behind on every `--help`.
    expect(existsSync(dir)).toBe(false)
  })

  it('knows no session, whatever it is asked', () => {
    expect(store.has('20260823-074139-k3f9')).toBe(false)
    expect(store.summarise('20260823-074139-k3f9')).toBeUndefined()
  })
})

describe('starting a session', () => {
  it('names it after the moment it started, and leaves no file yet', () => {
    const session = store.create()

    expect(session.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/)
    expect(session.log.length).toBe(0)
    // A session nobody has said anything in has not happened. It must not
    // leave an empty file for the next `list` to offer as a conversation.
    expect(existsSync(join(dir, `${session.id}.jsonl`))).toBe(false)
  })

  it('writes the journal as soon as there is a fact to write', () => {
    const session = store.create()

    session.log.append('user/message', { id: 'm1', text: 'hello' })

    expect(readFileSync(join(dir, `${session.id}.jsonl`), 'utf8')).toContain('"user/message"')
    expect(store.has(session.id)).toBe(true)
  })

  it('never hands two sessions the same name, even inside one millisecond', () => {
    // Same clock, same suffix: the two inputs an id is made of, both held
    // still. A second session that reused the name would open the first one's
    // journal and append to a conversation it has never seen.
    const frozen = openSessionStore({ dir, now: () => clock, random: () => 0.5 })

    const first = frozen.create()
    const second = frozen.create()

    expect(second.id).not.toBe(first.id)
    frozen.close()
  })

  it('is the only session in the list until it has said something', () => {
    const session = store.create()

    // Listed while still empty, because the session this run started is
    // exactly the one somebody is about to type into.
    expect(store.list().map((summary) => summary.id)).toEqual([session.id])
    expect(store.list()[0]?.events).toBe(0)
  })
})

describe('opening a session', () => {
  it('hands back the same log twice, rather than two views of one journal', () => {
    const first = store.create()
    const second = store.open(first.id)

    expect(second.log).toBe(first.log)
  })

  it('reads the conversation back after the session was let go', () => {
    const session = store.create()
    session.log.append('user/message', { id: 'm1', text: 'hello' })
    session.log.append('assistant/message', { id: 'm1', text: 'hi' })
    const { id } = session
    session.close()

    const reopened = store.open(id)

    expect(reopened.log.events.map((event) => event.type)).toEqual([
      'user/message',
      'assistant/message',
    ])
    expect(reopened.log.append('user/message', { id: 'm2', text: 'again' }).seq).toBe(2)
  })

  it('starts an unknown id rather than failing, because an empty log is an empty log', () => {
    const session = store.open('handpicked')

    expect(session.log.length).toBe(0)
    // `has` is what tells a caller the difference, and a server asks it before
    // opening anything a stranger named.
    expect(store.has('handpicked')).toBe(true)
  })

  it('refuses an id that is not one', () => {
    for (const id of ['../escape', 'nested/session', '', '.', 'session.jsonl']) {
      expect(() => store.open(id)).toThrow(TypeError)
      expect(store.has(id)).toBe(false)
      expect(store.summarise(id)).toBeUndefined()
    }
    // And nothing was written on the way to refusing.
    expect(existsSync(dir)).toBe(false)
  })
})

describe('summarising', () => {
  it('folds the log into what a list needs', () => {
    const session = store.create()
    session.log.append('demo/hello', { message: 'the log exists' })
    clock += 5_000
    session.log.append('user/message', { id: 'm1', text: '  what   is a harness?\n' })
    clock += 5_000
    session.log.append('assistant/message', { id: 'm1', text: 'this' })

    expect(store.summarise(session.id)).toEqual({
      id: session.id,
      events: 3,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      // The opening question, on one line: the one name nobody has to invent.
      title: 'what is a harness?',
    })
  })

  it('has no title until the human says something', () => {
    const session = store.create()
    session.log.append('demo/hello', { message: 'the log exists' })

    expect(store.summarise(session.id)?.title).toBeUndefined()
  })

  it('trims a title to one line of a list', () => {
    const session = store.create()
    session.log.append('user/message', { id: 'm1', text: 'x'.repeat(200) })

    const title = store.summarise(session.id)?.title
    expect(title).toHaveLength(80)
    expect(title?.endsWith('…')).toBe(true)
  })

  it('answers from the log while a session is open, not from its file', () => {
    const session = store.create()
    session.log.append('user/message', { id: 'm1', text: 'first' })

    // Same answer either way — an event is on disk before anyone hears about
    // it — but only one of them is the log.
    expect(store.summarise(session.id)?.events).toBe(1)
    expect(store.list()[0]?.events).toBe(1)
  })
})

describe('listing what is on the shelf', () => {
  it('puts the most recently active session first', () => {
    plant('older.jsonl', line(0, 'user/message', { id: 'm1', text: 'older' }))
    clock += 60_000
    plant('newer.jsonl', line(0, 'user/message', { id: 'm2', text: 'newer' }))

    expect(store.list().map((summary) => summary.id)).toEqual(['newer', 'older'])
  })

  it('puts a session that has not spoken yet ahead of every stored one', () => {
    plant('older.jsonl', line(0, 'user/message', { id: 'm1', text: 'older' }))
    const started = store.create()

    expect(store.list().map((summary) => summary.id)).toEqual([started.id, 'older'])
  })

  it('ignores a file that is not a journal it could have written', () => {
    plant('notes.txt', 'nothing to do with sessions\n')
    plant('with spaces.jsonl', line(0, 'demo/hello'))
    plant('empty.jsonl', '')
    mkdirSync(join(dir, 'directory.jsonl'), { recursive: true })
    plant('real.jsonl', line(0, 'demo/hello'))

    expect(store.list().map((summary) => summary.id)).toEqual(['real'])
  })

  it('describes a damaged journal by its readable prefix, and leaves it alone', () => {
    const torn = `${line(0, 'user/message', { id: 'm1', text: 'first' })}{"seq":1,"type":"assist`
    plant('torn.jsonl', torn)

    expect(store.list()).toEqual([
      {
        id: 'torn',
        events: 1,
        startedAt: clock,
        updatedAt: clock,
        title: 'first',
      },
    ])
    // Reading is not repairing. A list that truncated every file it described
    // would make browsing a session a way to lose one.
    expect(readFileSync(join(dir, 'torn.jsonl'), 'utf8')).toBe(torn)
  })

  it('repairs that journal when the session is actually opened', () => {
    plant(
      'torn.jsonl',
      `${line(0, 'user/message', { id: 'm1', text: 'first' })}{"seq":1,"type":"assist`,
    )
    const repairs: string[] = []
    const opening = openSessionStore({
      dir,
      now: () => clock,
      onRepair: (repair, id) => repairs.push(`${id}: ${repair.reason}`),
    })

    const session = opening.open('torn')

    expect(session.log.length).toBe(1)
    expect(repairs).toEqual(['torn: partly written line'])
    // The next append has to land on a whole line, or the torn record takes a
    // real one down with it.
    session.log.append('assistant/message', { id: 'm1', text: 'second' })
    opening.close()
    expect(openSessionStore({ dir }).open('torn').log.length).toBe(2)
  })
})
