<script lang="ts">
import { readToken, writeToken } from '$lib/api/client'
import { Button } from '$lib/components/ui/button'
import * as Dialog from '$lib/components/ui/dialog'
import { app } from '$lib/state/app.svelte'

let { open = $bindable(false) }: { open?: boolean } = $props()

let token = $state('')

$effect(() => {
  if (open) token = readToken() ?? ''
})

const connect = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault()
  writeToken(token.length > 0 ? token : null)
  open = false
  await app.load()
}
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Access token</Dialog.Title>
      <Dialog.Description>
        This server requires a token to read — the same one you use in the userscript.
      </Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={connect}>
      <input
        class="input input-bordered w-full text-base sm:text-sm"
        type="password"
        autocomplete="off"
        required
        aria-label="access token"
        bind:value={token}
      />
      {#if app.authRequired && readToken() !== null}
        <p class="text-sm text-error">That token was rejected — it may have been revoked.</p>
      {/if}
      <Dialog.Footer>
        <Button type="submit">Connect</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
