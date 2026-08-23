/**
 * A harness server in a process of its own, so a test can kill it outright.
 *
 * A graceful shutdown proves nothing about durability: it runs the very
 * cleanup a crash skips. This process is started, used, and then killed with
 * `SIGKILL`, which no handler can intercept — whatever survives that survived
 * on the strength of the journal alone.
 *
 * Usage: `tsx harness-process.ts <journal path>`; prints `ready <port>`.
 *
 * @module
 */

import { basename, dirname } from 'node:path'
import { createScriptedAdapter } from '@harness/llm'
import { openSessionStore } from '@harness/session/store'
import { createHarnessServer } from '../../src/server.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('usage: harness-process <journal path>')

// A journal's file name is its session id, so a path is all this needs to
// serve the same session again on the other side of a kill.
const sessions = openSessionStore({ dir: dirname(path) })
const currentId = basename(path, '.jsonl')

const adapter = createScriptedAdapter({
  // The reply reports the request it was given, so a test can tell whether the
  // model's view spans the restart — the conversation is only continued if the
  // fold ran over the restored events too.
  reply: (messages) => `shown ${messages.length}`,
})

const { server } = createHarnessServer({ sessions, currentId, adapter, heartbeatMs: 0 })

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  process.stdout.write(`ready ${address.port}\n`)
})
