<script lang="ts">
  let { checked, disabled = false, onChange }: {
    checked: boolean
    disabled?: boolean
    onChange: (checked: boolean) => void
  } = $props()
</script>

<input class="checkbox checkbox-sm checkbox-primary" type="checkbox" {checked} {disabled} onchange={(event) => onChange(event.currentTarget.checked)} />

<style>
  /* DaisyUI checkbox-sm/checkbox-primary rules, scoped for our shadow-root hosts. */
  .checkbox {
    --input-color: var(--color-primary, var(--caelestis-primary));
    --size: calc(var(--size-selector, 0.25rem) * 5);
    box-sizing: border-box;
    appearance: none;
    display: inline-block;
    position: relative;
    flex-shrink: 0;
    vertical-align: middle;
    width: var(--size);
    height: var(--size);
    margin: 0;
    padding: 0.1875rem;
    border: var(--border, 1px) solid var(--input-color);
    border-radius: var(--radius-selector, 0.5rem);
    background-color: transparent;
    background-size: auto, calc(var(--noise, 0) * 100%);
    background-image: none, var(--fx-noise, none);
    color: var(--color-primary-content, white);
    box-shadow: 0 1px oklch(0% 0 0 / calc(var(--depth, 1) * 0.1)) inset;
    cursor: pointer;
    transition: background-color 200ms, box-shadow 200ms;
  }
  .checkbox::before {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background-color: currentColor;
    box-shadow: 0 3px oklch(100% 0 0 / calc(var(--depth, 1) * 0.1)) inset;
    clip-path: polygon(20% 100%, 20% 80%, 50% 80%, 50% 80%, 70% 80%, 70% 100%);
    opacity: 0;
    rotate: 45deg;
    transition: clip-path 300ms 100ms, opacity 100ms 100ms;
  }
  .checkbox:checked {
    background-color: var(--input-color);
    box-shadow: 0 8px 0 -4px oklch(100% 0 0 / calc(var(--depth, 1) * 0.1)) inset, 0 1px oklch(0% 0 0 / calc(var(--depth, 1) * 0.1));
  }
  .checkbox:checked::before { clip-path: polygon(20% 100%, 20% 80%, 50% 80%, 50% 0%, 70% 0%, 70% 100%); opacity: 1; }
  .checkbox:focus-visible { outline: 2px solid var(--input-color); outline-offset: 2px; }
  .checkbox:disabled { cursor: not-allowed; opacity: 0.2; }
  @media (prefers-reduced-motion: reduce) { .checkbox, .checkbox::before { transition: none; } }
  @media (forced-colors: active) {
    .checkbox { border-color: ButtonText; }
    .checkbox:checked { background: Highlight; }
    .checkbox:checked::before { background: HighlightText; }
  }
</style>
