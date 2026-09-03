import adapter from '@sveltejs/adapter-cloudflare'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const deploymentVersion = /^[0-9a-f]{40}$/i.test(process.env.CAELESTIS_BUILD_ID ?? '')
  ? (process.env.CAELESTIS_BUILD_ID ?? '').slice(0, 12)
  : 'development'

export default defineConfig({
  define: {
    __CAELESTIS_FRONTEND_VERSION__: JSON.stringify(deploymentVersion),
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

      adapter: adapter(),
    }),
  ],
})
