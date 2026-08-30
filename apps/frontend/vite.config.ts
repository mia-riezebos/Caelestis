import { readFileSync } from 'node:fs'
import adapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const packageMetadata = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  define: {
    __CAELESTIS_FRONTEND_VERSION__: JSON.stringify(packageMetadata.version),
  },
  resolve: {
    // Component tests run in happy-dom and need Svelte's client entry point rather than its SSR
    // default. Production browser builds already select this condition themselves.
    conditions: process.env.VITEST === 'true' ? ['browser'] : undefined,
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },

      // A static SPA: every read the app makes is an authenticated client-side fetch against the
      // template server, so there is nothing for a server render to know. `dist` matches the
      // `outputs` turbo.json already declares for `build`.
      adapter: adapter({ pages: 'dist', assets: 'dist', fallback: 'index.html' }),
    }),
  ],
})
