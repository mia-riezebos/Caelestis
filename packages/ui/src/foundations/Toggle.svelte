<script lang="ts">
  interface Props {
    label: string
    checked: boolean
    disabled?: boolean
    compact?: boolean
    control?: string
    onChange?: (checked: boolean) => void
  }

  let { label, checked, disabled = false, compact = false, control, onChange }: Props = $props()
</script>

<input
  type="checkbox"
  role="switch"
  aria-label={label}
  class:compact
  {checked}
  {disabled}
  data-caelestis-control={control}
  onchange={(event) => onChange?.(event.currentTarget.checked)}
/>

<style>
  input {
    --toggle-size: 1.25rem;
    --toggle-padding: calc(var(--toggle-size) * 0.125);
    --toggle-colour: color-mix(in oklab, var(--caelestis-text, var(--color-base-content, currentColor)) 50%, transparent);
    appearance: none;
    position: relative;
    display: inline-grid;
    flex-shrink: 0;
    grid-template-columns: 0fr 1fr 1fr;
    place-content: center;
    inline-size: calc((var(--toggle-size) * 2) - (var(--border, 1px) + var(--toggle-padding)) * 2);
    block-size: var(--toggle-size);
    margin: 0;
    padding: var(--toggle-padding);
    border: var(--border, 1px) solid currentColor;
    border-radius: calc(var(--caelestis-selector-radius, var(--radius-selector, 0.5rem)) + var(--toggle-padding) + var(--border, 1px));
    background: transparent;
    color: var(--toggle-colour);
    box-shadow: 0 1px color-mix(in oklab, currentColor calc(var(--depth, 1) * 10%), transparent) inset;
    cursor: pointer;
    transition: color 300ms, grid-template-columns 200ms;
  }

  input::before {
    content: '';
    position: relative;
    grid-column: 2;
    grid-row: 1;
    inline-size: 100%;
    block-size: 100%;
    aspect-ratio: 1;
    border-radius: var(--caelestis-selector-radius, var(--radius-selector, 0.5rem));
    background: currentColor;
    box-shadow:
      0 -1px oklch(0% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 8px 0 -4px oklch(100% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 1px color-mix(in oklab, currentColor calc(var(--depth, 1) * 10%), transparent);
  }

  input:checked { --toggle-colour: var(--caelestis-primary, var(--color-primary, oklch(0.58 0.17 252))); grid-template-columns: 1fr 1fr 0fr; background: var(--caelestis-surface, var(--color-base-100, white)); }
  input.compact { --toggle-size: 1rem; }
  input:disabled { cursor: not-allowed; opacity: 0.3; }
  input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    input::before { transition: background-color 100ms, translate 200ms; }
  }
</style>
