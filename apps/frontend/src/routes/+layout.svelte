<script lang="ts">
import { Moon, Sun } from '@lucide/svelte'
import { onMount } from 'svelte'
import { serverUrlIsConfigured } from '$lib/api/client'
import ConnectDialog from '$lib/components/ConnectDialog.svelte'
import { app } from '$lib/state/app.svelte'
import '../app.css'

const REPO_URL = 'https://github.com/mia-riezebos/Caelestis'

let { children } = $props()

let connectOpen = $state(false)

onMount(() => {
  void app.load()
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

      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        class="btn btn-sm btn-outline gap-1.5 rounded-full"
        title="Get the userscript from the Caelestis GitHub repository"
      >
        <!-- Lucide dropped brand icons; this is the Simple Icons GitHub mark. -->
        <svg viewBox="0 0 24 24" class="size-4 fill-current" aria-hidden="true">
          <path
            d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
          />
        </svg>
        <span class="max-sm:hidden">Install the userscript</span>
      </a>

      <button class="btn btn-sm btn-ghost btn-circle" onclick={toggleTheme} aria-label="toggle theme">
        <Sun class="size-4 hidden [[data-theme=caelestis-dark]_&]:block" />
        <Moon class="size-4 [[data-theme=caelestis-dark]_&]:hidden" />
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
