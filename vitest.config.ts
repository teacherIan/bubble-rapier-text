import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Test config, kept separate from vite.config.ts (the demo dev server) so the two can diverge
// without one breaking the other — the library build already needs its own config for the same
// reason. Node environment, no jsdom: everything under test here is pure geometry and planning
// (hull maths, the transition planner, layout), deliberately framework-free so it needs no DOM.
// Anything requiring a real canvas or WebGL belongs in a browser check, not a unit test.
//
// The '@' alias is retained purely as insurance. The source no longer uses it (see the note in
// celebratePhysics.ts — a published package can't rely on a consumer's alias), but keeping the
// mapping here means a stray '@/' import fails loudly in the test run rather than resolving into
// some consumer's tree later.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
