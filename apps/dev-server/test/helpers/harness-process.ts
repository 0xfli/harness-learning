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

import { createScriptedAdapter } from '@harness/llm'
import { restoreSession } from '@harness/session/journal'
import { createHarnessServer } from '../../src/server.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('usage: harness-process <journal path>')

const { log } = restoreSession({ path })

const adapter = createScriptedAdapter({
  // The reply reports the request it was given, so a test can tell whether the
  // model's view spans the restart — the conversation is only continued if the
  // fold ran over the restored events too.
  reply: (messages) => `shown ${messages.length}`,
})

const { server } = createHarnessServer({ log, adapter, heartbeatMs: 0 })

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  process.stdout.write(`ready ${address.port}\n`)
})
