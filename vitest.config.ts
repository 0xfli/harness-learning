import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node 22 keeps `EventSource` behind a flag, and the end-to-end feed test
    // wants the real one rather than a stand-in. Pool options are read from
    // the root config rather than from a project.
    poolOptions: { forks: { execArgv: ['--experimental-eventsource'] } },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/**/test/**/*.test.ts', 'apps/dev-server/test/**/*.test.ts'],
          // The SSE tests open real sockets; a hung stream should fail loudly
          // rather than stall the run.
          testTimeout: 10_000,
        },
      },
      // The browser half brings its own environment; see apps/web/vite.config.ts.
      './apps/web',
    ],
  },
})
