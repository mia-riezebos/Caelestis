import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    customElement: ({ filename }) => filename.endsWith('.element.svelte'),
    runes: true,
  },
}
