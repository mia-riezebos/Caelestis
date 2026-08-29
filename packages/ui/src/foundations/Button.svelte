<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    title?: string
    kind?: 'default' | 'primary' | 'danger' | 'danger-ghost' | 'ghost'
    size?: 'compact' | 'small' | 'normal'
    pressed?: boolean
    disabled?: boolean
    ariaDisabled?: boolean
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
    ariaDisabled = false,
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
  class:small={size === 'small'}
  class:primary={kind === 'primary'}
  class:danger={kind === 'danger'}
  class:danger-ghost={kind === 'danger-ghost'}
  class:ghost={kind === 'ghost'}
  {title}
  {disabled}
  aria-disabled={ariaDisabled}
  aria-label={iconOnly ? label : undefined}
  aria-pressed={pressed}
  data-caelestis-control={control}
  onclick={(event) => { if (!disabled && !ariaDisabled) onclick?.(event) }}
>
  {#if children !== undefined}{@render children()}{:else}{label}{/if}
</button>

<style>
  button {
    --button-size: 2.5rem;
    --button-padding: 1rem;
    --button-font-size: 0.875rem;
    --button-colour: var(--caelestis-raised-surface, var(--color-base-200, oklch(0.94 0.01 264)));
    --button-foreground: var(--caelestis-text, var(--color-base-content, oklch(0.26 0.025 264)));
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    inline-size: unset;
    block-size: var(--button-size);
    min-block-size: 0;
    padding-inline: var(--button-padding);
    border: var(--border, 1px) solid color-mix(in oklab, var(--button-colour), #000 calc(var(--depth, 1) * 5%));
    border-radius: var(--caelestis-field-radius, 0.65rem);
    outline-color: var(--button-colour);
    background: var(--button-colour);
    color: var(--button-foreground);
    box-shadow:
      0 0.5px 0 0.5px oklch(100% 0 0 / calc(var(--depth, 1) * 6%)) inset,
      0 3px 2px -2px color-mix(in oklab, var(--button-colour) calc(var(--depth, 1) * 30%), transparent),
      0 4px 3px -2px color-mix(in oklab, var(--button-colour) calc(var(--depth, 1) * 30%), transparent);
    font: 600 var(--button-font-size)/1 ui-sans-serif, system-ui, sans-serif;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }

  button.compact { --button-size: 1.5rem; --button-padding: 0.5rem; --button-font-size: 0.6875rem; }
  button.small { --button-size: 2rem; --button-padding: 0.75rem; --button-font-size: 0.75rem; }
  button.icon-only { inline-size: var(--button-size); padding-inline: 0; border-radius: 999px; }
  button.primary { --button-colour: var(--caelestis-primary, var(--color-primary, oklch(0.58 0.17 252))); --button-foreground: var(--color-primary-content, white); }
  button.danger { --button-colour: var(--caelestis-danger, var(--color-error, oklch(0.59 0.2 27))); --button-foreground: var(--color-error-content, white); }
  button.ghost, button.danger-ghost { border-color: transparent; background: transparent; box-shadow: none; }
  button.danger-ghost { color: var(--caelestis-danger, var(--color-error, currentColor)); }
  button[aria-pressed='true'] { --button-colour: color-mix(in oklab, var(--caelestis-raised-surface, var(--color-base-200)) 95%, #000); box-shadow: none; }
  @media (hover: hover) {
    button:hover:not(:disabled, [aria-disabled='true']) { --button-colour: color-mix(in oklab, var(--button-colour), #000 7%); }
    button:is(.ghost, .danger-ghost):hover:not(:disabled, [aria-disabled='true']) { background: color-mix(in oklab, currentColor 10%, transparent); }
  }
  button:active:not(:disabled, [aria-disabled='true']) { translate: 0 0.5px; box-shadow: none; }
  button:is(:disabled, [aria-disabled='true']) { pointer-events: none; cursor: not-allowed; opacity: 0.3; }
  button:focus-visible { outline: 2px solid var(--button-colour, var(--caelestis-focus, currentColor)); outline-offset: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    button { transition: color 200ms, background-color 200ms, border-color 200ms, box-shadow 200ms, transform 200ms; }
  }

  @media (forced-colors: active) {
    button { border-color: ButtonText; }
    button.primary, button.danger { background: Highlight; color: HighlightText; }
  }
</style>
