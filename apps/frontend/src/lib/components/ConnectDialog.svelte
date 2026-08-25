<script lang="ts">
import {
  readServerUrl,
  readToken,
  serverUrlIsConfigured,
  writeConnection,
} from '$lib/api/client'
import { Button } from '$lib/components/ui/button'
import * as Dialog from '$lib/components/ui/dialog'
import { app } from '$lib/state/app.svelte'

let { open = $bindable(false) }: { open?: boolean } = $props()

let serverUrl = $state('')
let token = $state('')

$effect(() => {
  if (open) {
    serverUrl = readServerUrl()
    token = readToken() ?? ''
  }
})

const connect = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault()
  writeConnection(serverUrl, token.length > 0 ? token : null)
  open = false
  await app.load()
}
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {serverUrlIsConfigured ? 'Access token' : 'Connect to a template server'}
      </Dialog.Title>
      <Dialog.Description>
        {serverUrlIsConfigured
          ? 'Enter the access token you use in the userscript.'
          : 'Enter a server URL and, if required, its access token.'}
      </Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={connect}>
      {#if !serverUrlIsConfigured}
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">Server URL</span>
          <input
            class="input input-bordered w-full text-base sm:text-sm"
            type="url"
            required
            placeholder="https://templates.example.org"
            bind:value={serverUrl}
          />
        </label>
      {/if}
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Access token</span>
        <input
          class="input input-bordered w-full text-base sm:text-sm"
          type="password"
          autocomplete="off"
          placeholder="Leave empty for open servers"
          bind:value={token}
        />
      </label>
      {#if app.authRequired}
        <p class="text-sm text-error">This server requires a token with read access.</p>
      {/if}
      <Dialog.Footer>
        <Button type="submit">Connect</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
