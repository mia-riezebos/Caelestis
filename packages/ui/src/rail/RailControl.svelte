<script lang="ts">
  import type { RailControlIntent, RailControlModel } from '../types.js'

  let { model, onIntent }: { model: RailControlModel; onIntent?: (intent: RailControlIntent) => void } = $props()

  const paths = {
    panel: 'M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T760-120H608q0-50-31.5-85T500-240q-45 0-76.5 35T392-120Z',
    colour: 'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 331-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Z',
    mismatch: 'M480-120q-65 0-120.5-32T272-240H160v-80h84q-3-20-3.5-40t-.5-40h-80v-80h80q0-20 .5-40t3.5-40h-84v-80h112q14-23 31.5-43t40.5-35l-64-66 56-56 82 82q28-9 57-9t57 9l84-82 56 56-66 66q23 15 41 34.5t32 42.5h112v80h-84q3 20 3.5 40t.5 40h80v80h-80q0 20-.5 40t-3.5 40h84v80H688q-32 56-87.5 88T480-120Zm-80-200h160v-80H400v80Zm0-160h160v-80H400v80Z',
    'overlay-menu': 'M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z',
    'overlay-visible': 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z',
    'overlay-move': 'M480-80 340-220l57-57 43 43v-127h80v127l43-43 57 57L480-80ZM220-340 80-480l140-140 57 57-43 43h127v80H234l43 43-57 57Zm520 0-57-57 43-43H599v-80h127l-43-43 57-57 140 140-140 140ZM440-599v-127l-43 43-57-57 140-140 140 140-57 57-43-43v127h-80Z',
    'overlay-delete': 'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360Z',
    'placement-apply': 'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z',
    'placement-cancel': 'M256-200l-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
  } as const
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
  onclick={() => { if (!model.disabled) onIntent?.({ type: 'activate', id: model.id }) }}
>
  <svg viewBox="0 -960 960 960" aria-hidden="true"><path d={paths[model.id]} /></svg>
  {#if model.badge !== undefined && model.badge > 0}
    <span class="badge" aria-label={`${model.badge} new alarms`}>{model.badge}</span>
  {/if}
</button>

<style>
  button { position: relative; display: grid; place-items: center; inline-size: var(--caelestis-touch-target, 2.75rem); block-size: var(--caelestis-touch-target, 2.75rem); padding: 0; border: 1px solid var(--caelestis-border, rgb(255 255 255 / 0.14)); border-radius: var(--caelestis-field-radius, 0.65rem); background: var(--caelestis-surface, oklch(0.27 0.025 264)); color: var(--caelestis-text, oklch(0.91 0.015 264)); box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); cursor: pointer; }
  button.pressed { border-color: transparent; background: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  button.danger { color: var(--caelestis-danger, oklch(0.72 0.18 27)); }
  button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.5; }
  button:hover { filter: brightness(1.08); }
  button:active { transform: scale(0.96); }
  button:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.74 0.14 244)) 55%, transparent); outline-offset: 2px; }
  svg { inline-size: 1.25rem; block-size: 1.25rem; fill: currentColor; }
  .badge { position: absolute; inset-block-start: -0.35rem; inset-inline-end: -0.35rem; display: grid; place-items: center; min-inline-size: 1.2rem; block-size: 1.2rem; padding-inline: 0.25rem; border: 2px solid var(--caelestis-surface, oklch(0.27 0.025 264)); border-radius: 999px; background: var(--caelestis-danger, oklch(0.72 0.18 27)); color: white; font: 800 0.65rem/1 ui-sans-serif, system-ui, sans-serif; }
  @media (prefers-reduced-motion: no-preference) { button { transition: transform 120ms, filter 160ms, background-color 160ms; } }
</style>
