/**
 * Entry point: read the environment, restore the session from disk, pick a
 * model, then serve it.
 *
 * @module
 */

import { restoreSession } from '@harness/session/journal'
import { adapterFromEnv } from './adapter.ts'
import { describePath, loadEnvFile } from './env-file.ts'
import { createHarnessServer, seedDemoEvents } from './server.ts'

// First, because everything below reads `process.env` and a file that lands
// after the first read is a file that only works sometimes.
const envFile = loadEnvFile({ path: process.env.HARNESS_ENV_FILE })

const port = Number(process.env.PORT ?? 8787)
const journalPath = process.env.HARNESS_SESSION ?? '.harness/session.jsonl'
const adapter = adapterFromEnv()

// Before the server exists, because everything the harness knows comes back
// from here — including whether this is a fresh session at all.
const session = restoreSession({ path: journalPath })
const { log } = session
const restored = log.length

const { server, close } = createHarnessServer({ log, adapter })

// Only on a genuinely empty log. Seeding a restored session would append three
// invented facts to a real conversation on every restart.
if (restored === 0) seedDemoEvents(log)

server.listen(port, () => {
  console.log(`session log listening on http://localhost:${port}`)
  // The path only. What is inside it is the reason the file exists.
  if (envFile !== undefined) console.log(`  env: ${describePath(envFile)}`)
  console.log(`  model: ${adapter.name}`)
  console.log(`  journal: ${journalPath} (${restored} event${restored === 1 ? '' : 's'} restored)`)
  console.log(`  curl -N http://localhost:${port}/events`)
  console.log(
    `  curl -X POST http://localhost:${port}/messages -H 'content-type: application/json' -d '{"text":"hello"}'`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().then(() => {
      session.close()
      process.exit(0)
    })
  })
}
