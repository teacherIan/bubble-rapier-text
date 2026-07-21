import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
import { fileURLToPath } from 'node:url'

// The library build: `npm run build:lib` → dist/ (ESM bundle + .d.ts), with React, PIXI,
// and Rapier left external (consumers provide them). The package's `exports` point at this
// dist output; `prepare`/`prepack` run it, so git installs and tarballs ship compiled.
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src'],
      exclude: ['demo', '**/*.test.*'],
      rollupTypes: false,
      tsconfigPath: './tsconfig.app.json',
      // tsconfig.app.json runs the type-checker with noEmit; flip emit on (declarations
      // only) for the library build so the .d.ts files actually land in dist/.
      compilerOptions: { declaration: true, emitDeclarationOnly: true, noEmit: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'bubble-rapier-text.js',
    },
    rollupOptions: {
      // Don't bundle the heavy engines or React — keep the library lean and avoid duplicate
      // copies in the consumer's graph.
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'pixi.js',
        'pixi.js/unsafe-eval',
        '@dimforge/rapier2d-compat',
      ],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
})
