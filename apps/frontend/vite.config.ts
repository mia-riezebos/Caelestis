import adapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
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
