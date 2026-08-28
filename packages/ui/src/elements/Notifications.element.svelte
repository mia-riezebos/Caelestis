<svelte:options
  customElement={{
    shadow: 'open',
    props: { model: { type: 'Object' } },
  }}
/>

<script lang="ts">
  import Notifications from '../notifications/Notifications.svelte'
  import type { NotificationsIntent, NotificationsModel } from '../types.js'

  const EMPTY_MODEL = { toasts: [], confirm: null } as const
  let { model = EMPTY_MODEL }: { model?: NotificationsModel } = $props()
  const element: HTMLElement = $host()

  const emit = (detail: NotificationsIntent): void => {
    element.dispatchEvent(
      new CustomEvent('caelestis-notifications-intent', {
        detail,
        bubbles: true,
        composed: true,
      }),
    )
  }
</script>

<Notifications {model} onIntent={emit} />

<style>
  :host { display: contents; }
</style>
