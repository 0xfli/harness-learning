import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    // The SSE tests open real sockets; a hung stream should fail loudly rather
    // than stall the run.
    testTimeout: 10_000,
  },
})
