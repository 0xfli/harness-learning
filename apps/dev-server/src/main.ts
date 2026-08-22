/**
 * Entry point: pick a model, seed a few demo events, then serve them.
 *
 * @module
 */

import { adapterFromEnv } from './adapter.ts'
import { createHarnessServer, seedDemoEvents } from './server.ts'

const port = Number(process.env.PORT ?? 8787)
const adapter = adapterFromEnv()
const { log, server, close } = createHarnessServer({ adapter })

seedDemoEvents(log)

server.listen(port, () => {
  console.log(`session log listening on http://localhost:${port}`)
  console.log(`  model: ${adapter.name}`)
  console.log(`  curl -N http://localhost:${port}/events`)
  console.log(
    `  curl -X POST http://localhost:${port}/messages -H 'content-type: application/json' -d '{"text":"hello"}'`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().then(() => process.exit(0))
  })
}
