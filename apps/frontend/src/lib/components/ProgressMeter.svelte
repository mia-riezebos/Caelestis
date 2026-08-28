<script lang="ts">
import type { Progress } from '$lib/tree'
import { cn } from '$lib/utils'

let {
  progress,
  size = 'md',
  showPercent = true,
  griefWatch = false,
  class: className,
}: {
  progress: Progress
  size?: 'sm' | 'md'
  showPercent?: boolean
  /** A finished template with wrong pixels is an alarm, not ordinary progress. */
  griefWatch?: boolean
  class?: string
} = $props()

const percent = $derived(progress.total === 0 ? 0 : (progress.completed / progress.total) * 100)
const scanned = $derived(progress.total === 0 ? 0 : (progress.known / progress.total) * 100)
const width = (value: number): string =>
  progress.total === 0 ? '0%' : `${(value / progress.total) * 100}%`
</script>

<!--
  The meter shows completed, mismatched, and blank pixels. Unscanned pixels leave the track empty.
-->
<div class={cn('flex min-w-0 items-center gap-2', className)}>
  <div
    class={cn(
      'flex min-w-0 flex-1 overflow-hidden rounded-full border border-base-300 bg-base-200',
      size === 'sm' ? 'h-2' : 'h-3',
    )}
    role="meter"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(percent)}
    aria-label="painted {Math.round(percent)}%, scanned {Math.round(scanned)}%"
  >
    <div
      class={griefWatch && progress.mismatched > 0 ? 'h-full bg-error/25' : 'h-full bg-success'}
      style:width={width(progress.completed)}
    ></div>
    <div class="h-full bg-error" style:width={width(progress.mismatched)}></div>
    <div
      class="h-full bg-base-content/20"
      style:width={width(progress.unpainted)}
    ></div>
  </div>
  {#if showPercent}
    <span
      class={cn(
        'shrink-0 font-semibold tabular-nums',
        griefWatch && progress.mismatched > 0 && 'text-error',
        size === 'sm' ? 'text-xs' : 'text-sm',
      )}
    >
      {percent >= 99.95 && percent < 100 ? '99.9' : (Math.round(percent * 10) / 10).toFixed(1)}%
    </span>
  {/if}
</div>
