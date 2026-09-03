<script lang="ts">
  import type { TreeProgressModel } from '../types.js'

  let { progress, size = 'md', showPercent = true, griefWatch = false, completedColour, class: className = '' }: {
    progress: TreeProgressModel
    size?: 'sm' | 'md'
    showPercent?: boolean
    griefWatch?: boolean
    completedColour?: string
    class?: string
  } = $props()
  const wholePercent = (value: number): number => {
    if (progress.total <= 0) return 0
    const rounded = Math.round(Math.min(1, Math.max(0, value / progress.total)) * 100)
    return value < progress.total ? Math.min(99, rounded) : rounded
  }
  const percent = $derived(progress.total === 0 ? 0 : (progress.completed / progress.total) * 100)
  const paintedPercent = $derived(wholePercent(progress.completed))
  const scannedPercent = $derived(wholePercent(progress.known))
  const width = (value: number): string => progress.total === 0 ? '0%' : `${(value / progress.total) * 100}%`
</script>

<div class={`meter-wrap ${className}`} style={completedColour === undefined ? undefined : `--caelestis-progress-completed: ${completedColour}`}>
  <div class:small={size === 'sm'} class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={paintedPercent} aria-label={`painted ${paintedPercent}%, scanned ${scannedPercent}%`}>
    <span class:alarm={griefWatch && progress.mismatched > 0} class="completed" style:width={width(progress.completed)}></span>
    <span class="mismatched" style:width={width(progress.mismatched)}></span>
    <span class="unpainted" style:width={width(progress.unpainted)}></span>
  </div>
  {#if showPercent}<span class:alarm-text={griefWatch && progress.mismatched > 0} class:small={size === 'sm'} class="percent">{paintedPercent}%</span>{/if}
</div>

<style>
  .meter-wrap { display: flex; min-inline-size: 0; align-items: center; gap: 0.5rem; }
  .track { display: flex; flex: 1; min-inline-size: 0; block-size: 0.75rem; overflow: hidden; border: 1px solid var(--caelestis-border); border-radius: 999px; background-color: var(--caelestis-raised-surface); background-image: repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in oklch, var(--caelestis-text) 10%, transparent) 3px 4px); }
  .track.small { block-size: 0.375rem; border: 0; }
  .track span { block-size: 100%; }
  .completed { background: var(--caelestis-progress-completed, var(--caelestis-success)); }
  .completed.alarm { opacity: 0.25; }
  .mismatched { background: var(--caelestis-danger); }
  .unpainted { background: color-mix(in oklch, var(--caelestis-text) 20%, transparent); }
  .percent { flex: 0 0 auto; font: 700 0.85rem/1 ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .percent.small { font-size: 0.625rem; }
  .alarm-text { color: var(--caelestis-danger); }
</style>
