<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    title?: string
    kind?: 'default' | 'primary' | 'danger' | 'ghost'
    size?: 'compact' | 'normal'
    pressed?: boolean
    disabled?: boolean
    iconOnly?: boolean
    control?: string
    onclick?: (event: MouseEvent) => void
    children?: Snippet
  }

  let {
    label,
    title,
    kind = 'default',
    size = 'normal',
    pressed,
    disabled = false,
    iconOnly = false,
    control,
    onclick,
    children,
  }: Props = $props()
</script>

<button
  type="button"
  class:icon-only={iconOnly}
  class:compact={size === 'compact'}
  class:primary={kind === 'primary'}
  class:danger={kind === 'danger'}
  class:ghost={kind === 'ghost'}
  {title}
  {disabled}
  aria-label={iconOnly ? label : undefined}
  aria-pressed={pressed}
  data-caelestis-control={control}
  {onclick}
>
  {#if children !== undefined}{@render children()}{:else}{label}{/if}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-block-size: var(--caelestis-touch-target, 2.75rem);
    padding-inline: 0.8rem;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-field-radius, 0.65rem);
    background: var(--caelestis-raised-surface, oklch(0.94 0.01 264));
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    font: 700 0.8rem/1 ui-sans-serif, system-ui, sans-serif;
    cursor: pointer;
  }

  button.compact { min-block-size: var(--caelestis-compact-target, 2rem); padding-inline: 0.55rem; font-size: 0.72rem; }
  button.icon-only { inline-size: var(--caelestis-touch-target, 2.75rem); padding: 0; border-radius: 999px; }
  button.icon-only.compact { inline-size: var(--caelestis-compact-target, 2rem); }
  button.primary { border-color: transparent; background: var(--caelestis-primary, oklch(0.58 0.17 252)); color: white; }
  button.danger { border-color: transparent; background: var(--caelestis-danger, oklch(0.59 0.2 27)); color: white; }
  button.ghost { border-color: transparent; background: transparent; }
  button:hover:not(:disabled) { filter: brightness(0.96); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { cursor: wait; opacity: 0.5; }
  button:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.62 0.17 252)) 55%, transparent); outline-offset: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    button { transition: transform 120ms, filter var(--caelestis-motion-duration, 160ms); }
  }

  @media (forced-colors: active) {
    button { border-color: ButtonText; }
    button.primary, button.danger { background: Highlight; color: HighlightText; }
  }
</style>
