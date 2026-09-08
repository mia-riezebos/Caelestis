<script lang="ts">
import { Icon } from '@caelestis/ui'
import { onMount, untrack } from 'svelte'
import { readToken, serverUrlIsConfigured, usesServerReadProxy } from '$lib/api/client'
import ConnectDialog from '$lib/components/ConnectDialog.svelte'
import { provideApp } from '$lib/state/app.svelte'
import '../app.css'
import type { LayoutProps } from './$types'

const REPO_URL = 'https://github.com/mia-riezebos/Caelestis'

let { children, data }: LayoutProps = $props()

const app = untrack(() => provideApp(data.bootstrap))

let connectOpen = $state(false)

onMount(() => {
  app.startLive()
  // SSR supplied the public read model. A browser-held credential may upgrade it to admin.
  if (
    readToken() !== null ||
    !usesServerReadProxy() ||
    data.bootstrap.needsRecovery ||
    app.manifest === null
  ) {
    void app.load()
  }
  return () => app.stopLive()
})

// An auth failure opens the connect dialog. A valid token fixes it.
$effect(() => {
  if (app.authRequired) connectOpen = true
})

const toggleTheme = (): void => {
  const current =
    document.documentElement.dataset.theme ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'caelestis-dark' : 'caelestis')
  const next = current === 'caelestis-dark' ? 'caelestis' : 'caelestis-dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem('caelestis:theme', next)
}
</script>

<svelte:head>
  <title>{app.server === null ? 'Caelestis' : `${app.server.name} · Caelestis`}</title>
</svelte:head>

<div class="flex min-h-dvh flex-col">
  <header class="sticky top-0 z-20 border-b-[1.5px] border-base-300 bg-base-100/90 backdrop-blur">
    <div class="container mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
      <a href="/" class="flex items-center gap-2" aria-label="Caelestis home">
        <span class="font-pixel text-lg leading-none text-primary">Caelestis</span>
      </a>

      <div class="flex-1"></div>
      <a href="/work" class="btn btn-sm btn-ghost">Work</a>

      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        class="btn btn-sm btn-outline gap-1.5 rounded-lg"
        title="Get the userscript from the Caelestis GitHub repository"
      >
        <Icon name="github" class="size-4" />
        <span class="max-sm:hidden">Install the userscript</span>
      </a>

      <button class="btn btn-sm btn-ghost btn-circle" onclick={toggleTheme} aria-label="toggle theme">
        <Icon name="lightMode" class="size-4 hidden [[data-theme=caelestis-dark]_&]:block" />
        <Icon name="darkMode" class="size-4 [[data-theme=caelestis-dark]_&]:hidden" />
      </button>
    </div>
  </header>

  <main class="container mx-auto w-full max-w-6xl flex-1 px-4 py-6">
    {@render children()}
  </main>

  <footer class="border-t-[1.5px] border-base-300 py-4">
    <div class="container mx-auto flex w-full max-w-6xl items-center justify-between px-4 text-xs text-base-content/50">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" class="link link-hover">
        Map tiles © OpenStreetMap contributors
      </a>
      <span class="flex items-center gap-3">
        {#if !serverUrlIsConfigured}
          <button class="link link-hover" onclick={() => (connectOpen = true)}>
            {app.server === null ? 'connect to a server' : `server: ${app.server.name}`}
          </button>
        {:else if app.server?.auth === 'access_token'}
          <button class="link link-hover" onclick={() => (connectOpen = true)}>access token</button>
        {/if}
        <a href={REPO_URL} target="_blank" rel="noreferrer" class="link link-hover">source on GitHub</a>
      </span>
    </div>
  </footer>
</div>

<ConnectDialog bind:open={connectOpen} />
