/**
 * The acceptance criteria for step #6, run against real processes.
 *
 * Every other test in this repo restarts a session by constructing one. These
 * kill a process with `SIGKILL` and start a new one over the same file,
 * because the interesting failures — a half-written line, a `seq` that starts
 * again at zero, a conversation the model cannot see — only exist on the other
 * side of a process boundary.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveMessages } from '@harness/exchange'
import { restoreSession } from '@harness/session/journal'
import type { SessionEvent } from '@harness/session'

const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
const SCRIPT = fileURLToPath(new URL('./helpers/harness-process.ts', import.meta.url))

/** A harness child: no stdin, and both output streams piped back here. */
type HarnessProcess = ChildProcessByStdio<null, Readable, Readable>

const running = new Set<HarnessProcess>()
const directories = new Set<string>()

afterEach(() => {
  for (const child of running) child.kill('SIGKILL')
  running.clear()
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'harness-restart-'))
  directories.add(directory)
  return join(directory, 'session.jsonl')
}

/** Start a harness over `path` and wait until it is listening. */
async function start(path: string): Promise<{ child: HarnessProcess; origin: string }> {
  const child = spawn(TSX, [SCRIPT, path], { stdio: ['ignore', 'pipe', 'pipe'] })
  running.add(child)

  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /ready (\d+)\n/.exec(out)
      if (match?.[1] !== undefined) resolve(Number(match[1]))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.once('exit', (code) => reject(new Error(`harness exited with ${String(code)}: ${err}`)))
  })

  return { child, origin: `http://127.0.0.1:${port}` }
}

/** Kill a harness the way a crash would: no handlers, no flush, no close. */
function kill(child: HarnessProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => {
      running.delete(child)
      resolve()
    })
    child.kill('SIGKILL')
  })
}

async function say(origin: string, text: string): Promise<{ text: string; seq: number }> {
  const response = await fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const body = (await response.json()) as {
    text: string
    seq: { userMessage: number; assistantMessage: number }
  }
  return { text: body.text, seq: body.seq.assistantMessage }
}

async function history(origin: string): Promise<SessionEvent[]> {
  const response = await fetch(`${origin}/events.json`)
  return (await response.json()) as SessionEvent[]
}

describe('killing and restarting the process', () => {
  it('preserves the whole conversation and continues it', { timeout: 30_000 }, async () => {
    const path = journalPath()

    const first = await start(path)
    await say(first.origin, 'first question')
    const before = await history(first.origin)
    await kill(first.child)

    const second = await start(path)
    const after = await history(second.origin)

    // Same facts, same order, same seq — a restart is a reload, not a new
    // session that happens to look similar.
    expect(after).toEqual(before)
    expect(after.filter((event) => event.type === 'assistant/chunk').length).toBeGreaterThan(0)

    // And the model is shown the restored conversation, because the request is
    // folded out of the log rather than out of anything the dead process held.
    const reply = await say(second.origin, 'second question')
    expect(reply.text).toBe('shown 3')
    expect(deriveMessages(await history(second.origin)).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
  })

  it(
    'continues seq from the persisted maximum without collision',
    { timeout: 30_000 },
    async () => {
      const path = journalPath()

      const first = await start(path)
      const before = await say(first.origin, 'first question')
      await kill(first.child)

      const second = await start(path)
      const after = await say(second.origin, 'second question')
      const events = await history(second.origin)

      expect(after.seq).toBeGreaterThan(before.seq)
      expect(events.map((event) => event.seq)).toEqual(events.map((_unused, index) => index))
      expect(new Set(events.map((event) => event.seq)).size).toBe(events.length)
    },
  )

  it('starts up on a journal a kill cut mid-line', { timeout: 30_000 }, async () => {
    const path = journalPath()
    const first = await start(path)
    await say(first.origin, 'first question')
    await kill(first.child)
    const complete = readFileSync(path, 'utf8').trimEnd().split('\n').length
    // What a process killed between `write` and the end of a line leaves
    // behind: a record that was still being written, and so never happened.
    appendFileSync(path, '{"seq":99,"type":"assistant/chu')

    const second = await start(path)
    const events = await history(second.origin)

    expect(events).toHaveLength(complete)
    // The repair has to survive into the next append, or the torn line takes
    // the next real one down with it.
    await say(second.origin, 'second question')
    await kill(second.child)
    const { log, close } = restoreSession({ path })
    expect(log.length).toBeGreaterThan(complete)
    expect(log.events.map((event) => event.seq)).toEqual(log.events.map((_unused, i) => i))
    close()
  })
})
