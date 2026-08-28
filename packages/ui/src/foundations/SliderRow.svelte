<script lang="ts">
  interface Props {
    label: string
    value: number
    defaultValue: number
    min: number
    max: number
    step: number
    format: (value: number) => string
    compact?: boolean
    locked?: boolean
    disabled?: boolean
    onInput?: (value: number) => void
    onReset?: (value: number) => void
  }

  let {
    label,
    value,
    defaultValue,
    min,
    max,
    step,
    format,
    compact = false,
    locked = false,
    disabled = false,
    onInput,
    onReset,
  }: Props = $props()

  let local = $state(0)
  $effect(() => { local = value })

  const input = (): void => {
    if (!locked && !disabled) onInput?.(local)
  }

  const reset = (): void => {
    if (locked || disabled || Object.is(local, defaultValue)) return
    local = defaultValue
    onReset?.(defaultValue)
  }
</script>

<label class:compact class:disabled={disabled}>
  <span class="name">{label}</span>
  <input
    type="range"
    {min}
    {max}
    {step}
    {disabled}
    aria-label={label}
    aria-disabled={locked || disabled}
    bind:value={local}
    oninput={input}
    onpointerdown={(event) => { if (locked) event.preventDefault() }}
    onkeydown={(event) => { if (locked) event.preventDefault() }}
  />
  <span class="readout">{format(local)}</span>
  <button
    type="button"
    hidden={Object.is(local, defaultValue)}
    disabled={disabled}
    aria-disabled={locked || disabled}
    aria-label={`Reset ${label.toLowerCase()}`}
    title={`Reset ${label.toLowerCase()}`}
    onclick={reset}
  >↺</button>
</label>

<style>
  label { display: flex; align-items: center; gap: 0.75rem; min-block-size: 2.5rem; color: var(--caelestis-text, inherit); font: 500 0.85rem/1.2 ui-sans-serif, system-ui, sans-serif; }
  label.compact { gap: 0.5rem; min-block-size: 2rem; font-size: 0.75rem; }
  label.disabled { opacity: 0.45; }
  .name { flex: 0 1 auto; min-inline-size: 5rem; }
  .compact .name { min-inline-size: 3.5rem; }
  input { flex: 1; min-inline-size: 0; accent-color: var(--caelestis-primary, oklch(0.58 0.17 252)); }
  .readout { flex: 0 0 2.75rem; color: var(--caelestis-muted-text, color-mix(in oklch, currentColor 60%, transparent)); text-align: end; font-size: 0.72rem; font-variant-numeric: tabular-nums; }
  .compact .readout { flex-basis: 2.5rem; }
  button { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; padding: 0; border: 0; border-radius: 999px; background: transparent; color: inherit; font-size: 1rem; cursor: pointer; }
  button:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
  button:focus-visible, input:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.62 0.17 252)) 55%, transparent); outline-offset: 2px; }
</style>
