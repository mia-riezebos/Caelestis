import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import adapter from '@sveltejs/adapter-cloudflare'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const deploymentVersion = /^[0-9a-f]{40}$/i.test(process.env.CAELESTIS_BUILD_ID ?? '')
  ? (process.env.CAELESTIS_BUILD_ID ?? '').slice(0, 12)
  : 'development'

export default defineConfig(({ command }) => {
  const varsFile = new URL('./.dev.vars', import.meta.url)
  const devVars =
    command === 'serve' && existsSync(varsFile) ? parseEnv(readFileSync(varsFile, 'utf8')) : {}

  return {
    // Vite must forward upgrades itself; its HTTP middleware cannot run the Worker socket proxy.
    server: {
      proxy:
        devVars.CAELESTIS_SERVER && devVars.CAELESTIS_READ_TOKEN
          ? {
              '/api/v1/telemetry/live': {
                target: devVars.CAELESTIS_SERVER,
                changeOrigin: true,
                ws: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
                headers: { authorization: `Bearer ${devVars.CAELESTIS_READ_TOKEN}` },
              },
            }
          : undefined,
    },
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
  }
})
