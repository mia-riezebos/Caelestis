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
    appearance: none;
    position: relative;
    inline-size: 2.5rem;
    block-size: 1.4rem;
    margin: 0;
    border: 1px solid var(--caelestis-border, oklch(0.68 0.025 264));
    border-radius: 999px;
    background: var(--caelestis-raised-surface, oklch(0.84 0.015 264));
    cursor: pointer;
  }

  input::after {
    content: '';
    position: absolute;
    inset-block-start: 0.15rem;
    inset-inline-start: 0.15rem;
    inline-size: 0.98rem;
    block-size: 0.98rem;
    border-radius: 50%;
    background: var(--caelestis-surface, white);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
  }

  input:checked { border-color: transparent; background: var(--caelestis-primary, oklch(0.58 0.17 252)); }
  input:checked::after { transform: translateX(1.08rem); }
  input.compact { inline-size: 2rem; block-size: 1.15rem; }
  input.compact::after { inline-size: 0.78rem; block-size: 0.78rem; }
  input.compact:checked::after { transform: translateX(0.82rem); }
  input:disabled { cursor: not-allowed; opacity: 0.45; }
  input:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.62 0.17 252)) 55%, transparent); outline-offset: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    input, input::after { transition: transform 140ms, background-color 160ms; }
  }
</style>
