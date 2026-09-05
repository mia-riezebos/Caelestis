<script lang="ts">
  import { formatPixels } from '@caelestis/shared'
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
</script>

{#if (showLifecycle && (finished || frozen)) || alarmLabel !== null}
  <span class:compact class="states" aria-label="Template state">
    {#if showLifecycle && (finished || frozen)}
      <TemplateLifecycle {finished} {frozen} />
    {/if}
    {#if alarmLabel !== null}
      <span class="alarm" role="status" title={alarmLabel} aria-label={`Template alarm: ${alarmLabel}`} aria-atomic="true">
        <span class="alarm-mark" aria-hidden="true">⚠️</span>
        <span class="alarm-description">{alarmLabel}</span>
      </span>
    {/if}
  </span>
{/if}

<style>
  .states {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  .alarm {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 1rem;
    block-size: 1rem;
    font: 1rem/1 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  .compact .alarm { font-size: 0.875rem; }
  .alarm-description { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
