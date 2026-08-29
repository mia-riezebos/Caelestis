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
  button {
    --button-base-colour: var(--caelestis-raised-surface, var(--color-base-200, oklch(0.32 0.025 264)));
    --button-colour: var(--button-base-colour);
    position: relative;
    display: grid;
    place-items: center;
    inline-size: var(--caelestis-touch-target, 2.5rem);
    block-size: var(--caelestis-touch-target, 2.5rem);
    padding: 0;
    border: var(--border, 1px) solid color-mix(in oklab, var(--button-colour), #000 calc(var(--depth, 1) * 5%));
    border-radius: 999px;
    outline-color: var(--button-colour);
    background: var(--button-colour);
    color: var(--caelestis-text, oklch(0.91 0.015 264));
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  button.pressed { --button-base-colour: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  button.danger { color: var(--caelestis-danger, oklch(0.72 0.18 27)); }
  button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.5; }
  @media (hover: hover) { button:hover:not([aria-disabled='true']) { --button-colour: color-mix(in oklab, var(--button-base-colour), #000 7%); } }
  button:active:not([aria-disabled='true']) { translate: 0 0.5px; box-shadow: none; }
  button:focus-visible { outline: 2px solid var(--button-colour, var(--caelestis-focus, currentColor)); outline-offset: 2px; }
  .badge { position: absolute; inset-block-start: -0.35rem; inset-inline-end: -0.35rem; display: grid; place-items: center; min-inline-size: 1.2rem; block-size: 1.2rem; padding-inline: 0.25rem; border: 2px solid var(--button-colour); border-radius: 999px; background: var(--caelestis-danger, oklch(0.72 0.18 27)); color: white; font: 800 0.65rem/1 ui-sans-serif, system-ui, sans-serif; }
  @media (prefers-reduced-motion: no-preference) { button { transition: color 200ms, background-color 200ms, border-color 200ms, box-shadow 200ms, translate 200ms; } }
</style>
