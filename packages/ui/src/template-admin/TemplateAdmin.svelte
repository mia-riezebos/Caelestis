<script lang="ts">
  import type { TemplateAdminProps } from '../types.js'

  let {
    finished = false,
    frozen = false,
    busy = false,
    onFinishedChange,
    onFrozenChange,
  }: TemplateAdminProps = $props()
</script>

<div class="actions" role="group" aria-label="Template lifecycle">
  <button type="button" disabled={busy} onclick={() => onFinishedChange?.({ value: !finished })}>
    {finished ? 'Reopen template' : 'Mark finished'}
  </button>
  <button
    type="button"
    disabled={busy || (finished && frozen)}
    title={finished && frozen ? 'Reopen the template before thawing' : ''}
    onclick={() => onFrozenChange?.({ value: !frozen })}
  >
    {frozen ? 'Thaw timelapse' : 'Freeze timelapse'}
  </button>
</div>

<style>
  .actions {
    --_surface: var(--caelestis-surface, oklch(0.97 0.01 264));
    --_text: var(--caelestis-text, oklch(0.26 0.025 264));
    --_border: var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    --_focus: var(--caelestis-focus, oklch(0.62 0.17 252));
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    max-inline-size: 100%;
    color: var(--_text);
    font: 600 0.8rem/1.2 ui-sans-serif, system-ui, sans-serif;
  }

  button {
    min-block-size: 2.75rem;
    padding-inline: 0.8rem;
    border: 1px solid var(--_border);
    border-radius: 0.65rem;
    background: var(--_surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: color-mix(in oklch, var(--_text) 42%, var(--_border));
    background: color-mix(in oklch, var(--_text) 7%, var(--_surface));
  }

  button:active:not(:disabled) { transform: scale(0.97); }

  button:focus-visible {
    outline: 3px solid color-mix(in oklch, var(--_focus) 55%, transparent);
    outline-offset: 2px;
  }

  button:disabled { cursor: wait; opacity: 0.55; }

  @media (prefers-color-scheme: dark) {
    .actions {
      --_surface: var(--caelestis-surface, oklch(0.27 0.025 264));
      --_text: var(--caelestis-text, oklch(0.91 0.015 264));
      --_border: var(--caelestis-border, oklch(0.5 0.025 264 / 0.55));
      --_focus: var(--caelestis-focus, oklch(0.74 0.14 244));
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    button {
      transition: transform 120ms, border-color 160ms, background-color 160ms;
    }
  }

  @media (prefers-contrast: more) {
    button { border-color: currentColor; }
  }
</style>
