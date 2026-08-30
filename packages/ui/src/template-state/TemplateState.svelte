<script lang="ts">
  import type { TemplateStateProps } from '../types.js'

  let {
    finished = false,
    frozen = false,
    griefed = false,
    alarmKind,
    pixelsLost,
    compact = false,
  }: TemplateStateProps = $props()

  const alarmLabel = $derived(
    alarmKind === undefined
      ? null
      : `${alarmKind === 'sustained-griefing' ? 'Sustained griefing' : 'Regression'}${pixelsLost === undefined ? '' : ` · ${pixelsLost.toLocaleString()} px lost`}`,
  )
</script>

{#if finished || frozen || alarmLabel !== null}
  <span class:compact class="states" aria-label="Template state">
    {#if finished}<span class="state finished">Finished</span>{/if}
    {#if frozen}<span class="state frozen">Timelapse frozen</span>{/if}
    {#if finished && griefed}<span class="state griefed" role="status">Grief detected</span>{/if}
    {#if alarmLabel !== null}<span class="state alarm" class:sustained={alarmKind === 'sustained-griefing'} role="status">{alarmLabel}</span>{/if}
  </span>
{/if}

<style>
  .states {
    --_text: var(--caelestis-text, oklch(0.26 0.025 264));
    --_border: var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    --_finished: var(--caelestis-finished, oklch(0.63 0.14 154));
    --_frozen: var(--caelestis-frozen, oklch(0.64 0.13 238));
    --_danger: var(--caelestis-danger, oklch(0.59 0.2 27));
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
    max-inline-size: 100%;
    color: var(--_text);
    font: 600 0.75rem/1.15 ui-sans-serif, system-ui, sans-serif;
  }

  .state {
    display: inline-flex;
    align-items: center;
    min-block-size: 1.45rem;
    padding-inline: 0.5rem;
    border: 1px solid color-mix(in oklch, currentColor 35%, var(--_border));
    border-radius: 999px;
    background: color-mix(in oklch, currentColor 10%, transparent);
    white-space: nowrap;
  }

  .finished { color: var(--_finished); }
  .frozen { color: var(--_frozen); }
  .griefed { color: var(--_danger); font-weight: 750; }
  .alarm { color: var(--_danger); font-weight: 750; }
  .alarm.sustained { background: color-mix(in oklch, var(--_danger) 18%, transparent); }

  .compact .state {
    min-block-size: 1.15rem;
    padding-inline: 0.35rem;
    font-size: 0.66rem;
  }

  @media (prefers-color-scheme: dark) {
    .states {
      --_text: var(--caelestis-text, oklch(0.91 0.015 264));
      --_border: var(--caelestis-border, oklch(0.5 0.025 264 / 0.55));
      --_finished: var(--caelestis-finished, oklch(0.75 0.14 154));
      --_frozen: var(--caelestis-frozen, oklch(0.76 0.12 238));
      --_danger: var(--caelestis-danger, oklch(0.72 0.18 27));
    }
  }

  @media (prefers-contrast: more) {
    .state { border-color: currentColor; background: transparent; }
  }

  @media (forced-colors: active) {
    .state { border-color: CanvasText; }
  }
</style>
