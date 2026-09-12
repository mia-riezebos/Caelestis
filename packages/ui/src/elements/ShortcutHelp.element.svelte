<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import { resolveShortcutBindings } from '@caelestis/shared'
  import ShortcutHelp from '../shortcut-help/ShortcutHelp.svelte'
  import type { ShortcutHelpIntent, ShortcutHelpModel } from '../types.js'

  const DEFAULT_MODEL: ShortcutHelpModel = { platform: 'windows-linux', bindings: resolveShortcutBindings() }
  let { model = DEFAULT_MODEL }: { model?: ShortcutHelpModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: ShortcutHelpIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-shortcut-help-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<ShortcutHelp {model} onIntent={emit} />

<style>:host { display: block; }</style>
