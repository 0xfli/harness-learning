/**
 * Entry point: read the environment, open the shelf of sessions, pick a model,
 * then serve it.
 *
 * Note what this no longer does: it does not restore last night's
 * conversation. A run starts a session of its own, and the ones before it stay
 * on the shelf until something asks for one by name — see
 * `docs/adr/0009-a-run-starts-a-session.md`.
 *
 * @module
 */

import { openSessionStore } from '@harness/session/store'
import { adapterFromEnv } from './adapter.ts'
import { describePath, loadEnvFile } from './env-file.ts'
import { createHarnessServer } from './server.ts'

// First, because everything below reads `process.env` and a file that lands
// after the first read is a file that only works sometimes.
const envFile = loadEnvFile({ path: process.env.HARNESS_ENV_FILE })

const port = Number(process.env.PORT ?? 8787)
const dir = process.env.HARNESS_SESSIONS ?? '.harness/sessions'
const adapter = adapterFromEnv()

const sessions = openSessionStore({ dir })
const stored = sessions.list().length

// Resuming is opt-in, and it is opt-in by name: a typo that quietly started an
// empty session would look exactly like a conversation that had vanished.
const resume = process.env.HARNESS_SESSION
if (resume !== undefined && resume.length > 0 && !sessions.has(resume)) {
  const known = sessions.list().map((session) => session.id)
  console.error(`no session "${resume}" in ${dir}`)
  console.error(known.length === 0 ? '  (none stored yet)' : `  known: ${known.join(', ')}`)
  process.exit(1)
}

const { server, close, current } = createHarnessServer({
  sessions,
  adapter,
  ...(resume === undefined || resume.length === 0 ? {} : { currentId: resume }),
})

server.listen(port, () => {
  console.log(`session log listening on http://localhost:${port}`)
  // The path only. What is inside it is the reason the file exists.
  if (envFile !== undefined) console.log(`  env: ${describePath(envFile)}`)
  console.log(`  model: ${adapter.name}`)
  console.log(`  sessions: ${dir} (${stored} stored)`)
  const restored = current.log.length
  const state = restored === 0 ? 'new' : `${restored} event${restored === 1 ? '' : 's'} restored`
  console.log(`  current: ${current.id} (${state})`)
  console.log(`  curl -s http://localhost:${port}/sessions`)
  console.log(`  curl -N http://localhost:${port}/events`)
  console.log(
    `  curl -X POST http://localhost:${port}/messages -H 'content-type: application/json' -d '{"text":"hello"}'`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().then(() => {
      process.exit(0)
    })
  })
}
