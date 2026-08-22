/**
 * Entry point: seed a few demo events, then serve them.
 *
 * @module
 */

import { createHarnessServer, seedDemoEvents } from './server.ts'

const port = Number(process.env.PORT ?? 8787)
const { log, server, close } = createHarnessServer()

seedDemoEvents(log)

server.listen(port, () => {
  console.log(`session log listening on http://localhost:${port}`)
  console.log(`  curl -N http://localhost:${port}/events`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().then(() => process.exit(0))
  })
}
