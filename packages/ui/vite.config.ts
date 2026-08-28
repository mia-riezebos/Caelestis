import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    conditions: process.env.VITEST === 'true' ? ['browser'] : undefined,
  },
  plugins: [
    svelte({
      emitCss: false,
      dynamicCompileOptions: ({ filename }) => ({
        customElement: filename.endsWith('.element.svelte'),
        css: 'injected',
        runes: true,
      }),
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/elements/index.ts'),
      formats: ['es'],
      fileName: () => 'elements/index.js',
    },
  },
})
