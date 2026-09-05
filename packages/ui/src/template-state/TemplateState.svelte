<script lang="ts">
  import { formatCount, formatExactCount, formatPixels } from '@caelestis/shared'
  import TemplateLifecycle from './TemplateLifecycle.svelte'
  import type { TemplateStateProps } from '../types.js'

  let {
    finished = false,
    frozen = false,
    griefed = false,
    alarmKind,
    pixelsLost,
    compact = false,
    showLifecycle = true,
  }: TemplateStateProps = $props()

  const griefDetected = $derived(finished && griefed)
  const alarmTitle = $derived(
    alarmKind === 'sustained-griefing'
      ? 'Sustained griefing'
      : alarmKind === 'regression'
        ? griefDetected ? 'Grief detected · Regression' : 'Regression'
        : griefDetected ? 'Grief detected' : null,
  )
  const alarmLabel = $derived(
    alarmTitle === null
      ? null
      : `${alarmTitle}${alarmKind === undefined || pixelsLost === undefined ? '' : ` · ${formatPixels(pixelsLost)} lost`}`,
  )
  const alarmDisplay = $derived(
    alarmTitle !== null && alarmKind !== undefined && pixelsLost !== undefined
      ? `${alarmTitle} · ${compact ? formatCount(pixelsLost) : formatExactCount(pixelsLost)} px lost`
      : alarmLabel,
  )
</script>

{#if (showLifecycle && (finished || frozen)) || alarmLabel !== null}
  <span class:compact class="states" aria-label="Template state">
    {#if showLifecycle && (finished || frozen)}
      <TemplateLifecycle {finished} {frozen} />
    {/if}
    {#if alarmLabel !== null}
      <span class="alarm" role="status" title={alarmLabel} aria-label={`Template alarm: ${alarmLabel}`} aria-atomic="true">
        <span class="alarm-mark" aria-hidden="true">!</span>
        <span>{alarmDisplay}</span>
      </span>
    {/if}
  </span>
{/if}

<style>
  .states {
    --_text: var(--caelestis-text, oklch(0.26 0.025 264));
    --_danger: var(--caelestis-danger, oklch(0.59 0.2 27));
    display: inline-flex;
    flex-direction: column;
    gap: 0.25rem;
    max-inline-size: 100%;
    color: var(--_text);
    font: 500 0.8125rem/1.25rem ui-sans-serif, system-ui, sans-serif;
  }

  .alarm {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0.1875rem 0.375rem;
    border-inline-start: 2px solid var(--_danger);
    background: color-mix(in oklch, var(--_danger) 10%, transparent);
    font-weight: 700;
  }

  .alarm-mark { font-weight: 800; }
  .compact { font-size: 0.75rem; line-height: 1rem; }

  @media (prefers-color-scheme: dark) {
    .states {
      --_text: var(--caelestis-text, oklch(0.91 0.015 264));
      --_danger: var(--caelestis-danger, oklch(0.72 0.18 27));
    }
  }

  @media (prefers-contrast: more) {
    .alarm { border-inline-start-width: 3px; background: transparent; }
  }

  @media (forced-colors: active) {
    .alarm { color: CanvasText; border-color: CanvasText; background: Canvas; }
  }
</style>
