/**
 * Vite for the inspector, and the Vitest project that renders it.
 *
 * @module
 */

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** Where the session log lives. The page never learns this URL. */
const harnessOrigin = process.env.HARNESS_ORIGIN ?? 'http://localhost:8787'

export default defineConfig({
  // Tailwind v4 is CSS-first: the plugin is the whole install, and there is no
  // `tailwind.config.js` to keep in step with it. The Vitest project below
  // shares this config, where the plugin is inert — Vitest does not process
  // CSS, so it never sees a file Tailwind would transform.
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    // Proxying keeps the feed same-origin: no CORS on the server, and no
    // absolute URL compiled into the client.
    proxy: {
      '/events': { target: harnessOrigin, changeOrigin: true },
      '/health': { target: harnessOrigin, changeOrigin: true },
    },
  },
  test: {
    name: 'web',
    // jsdom has no EventSource, which is exactly why the feed client takes its
    // transport as an argument. Tests drive it by hand.
    environment: 'jsdom',
    // Rows carry a wall clock, so an assertion on rendered text is only stable
    // if the clock is.
    env: { TZ: 'UTC' },
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
  },
})
