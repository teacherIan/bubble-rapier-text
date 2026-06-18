import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Demo dev server + static demo build. `npm run dev` serves the demo at the repo root
// (index.html → demo/main.tsx), which mounts the celebration text, the hull editor, and
// the calibration lab behind a small switcher. `npm run build` emits the static demo.
//
// The library itself is built separately (`npm run build:lib` → vite.lib.config.ts).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // `@` → ./src, matching the source's own imports (e.g. celebratePhysics imports
      // '@/lib/physics/world'). Keeping the alias means the copied sources are unmodified.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: './',
})
