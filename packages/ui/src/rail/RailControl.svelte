<script lang="ts">
  import Icon, { type IconName } from '../foundations/Icon.svelte'
  import type { RailControlIntent, RailControlModel } from '../types.js'

  let { model, onIntent }: { model: RailControlModel; onIntent?: (intent: RailControlIntent) => void } = $props()

  const icons: Record<RailControlModel['id'], IconName> = {
    panel: 'extension',
    colour: 'palette',
    mismatch: 'bug',
    'overlay-menu': 'kebab',
    'overlay-visible': 'image',
    'overlay-move': 'move',
    'overlay-delete': 'trash',
    'placement-apply': 'check',
    'placement-cancel': 'close',
  }
</script>

<button
  type="button"
  class:pressed={model.pressed}
  class:danger={model.danger}
  title={model.label}
  aria-label={model.label}
  aria-pressed={model.pressed}
  aria-expanded={model.expanded}
  aria-controls={model.controls}
  aria-haspopup={model.popup}
  aria-disabled={model.disabled}
  data-caelestis-control={model.control}
  onclick={() => onIntent?.({ type: 'activate', id: model.id })}
>
  <Icon name={icons[model.id]} size="1.25rem" />
  {#if model.badge !== undefined && model.badge > 0}
    <span class="badge" aria-label={`${model.badge} new alarms`}>{model.badge}</span>
  {/if}
</button>

<style>
  button { position: relative; display: grid; place-items: center; inline-size: var(--caelestis-touch-target, 2.75rem); block-size: var(--caelestis-touch-target, 2.75rem); padding: 0; border: 1px solid var(--caelestis-border, rgb(255 255 255 / 0.14)); border-radius: 999px; background: var(--caelestis-surface, oklch(0.27 0.025 264)); color: var(--caelestis-text, oklch(0.91 0.015 264)); box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); cursor: pointer; }
  button.pressed { border-color: transparent; background: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  button.danger { color: var(--caelestis-danger, oklch(0.72 0.18 27)); }
  button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.5; }
  button:hover { filter: brightness(1.08); }
  button:active { transform: scale(0.96); }
  button:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.74 0.14 244)) 55%, transparent); outline-offset: 2px; }
  .badge { position: absolute; inset-block-start: -0.35rem; inset-inline-end: -0.35rem; display: grid; place-items: center; min-inline-size: 1.2rem; block-size: 1.2rem; padding-inline: 0.25rem; border: 2px solid var(--caelestis-surface, oklch(0.27 0.025 264)); border-radius: 999px; background: var(--caelestis-danger, oklch(0.72 0.18 27)); color: white; font: 800 0.65rem/1 ui-sans-serif, system-ui, sans-serif; }
  @media (prefers-reduced-motion: no-preference) { button { transition: transform 120ms, filter 160ms, background-color 160ms; } }
</style>
