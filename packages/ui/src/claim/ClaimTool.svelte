<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import type { ClaimShapeKind, ClaimToolIntent, ClaimToolModel } from '../types.js'

  let { model, onIntent }: { model: ClaimToolModel; onIntent: (intent: ClaimToolIntent) => void } =
    $props()

  const kinds: readonly { readonly kind: ClaimShapeKind; readonly label: string; readonly key: string }[] = [
    { kind: 'rectangle', label: 'Rectangle', key: 'M' },
    { kind: 'ellipse', label: 'Ellipse', key: 'L' },
    { kind: 'polygon', label: 'Polygon', key: '' },
    { kind: 'star', label: 'Star', key: '' },
  ]
  const hint = $derived(
    model.drawn
      ? 'Drag the handles to resize or rotate. Hold ⌘ or Ctrl and drag to move. Enter saves, Delete removes, Escape leaves.'
      : model.kind === 'rectangle' || model.kind === 'ellipse'
        ? 'Drag corner to corner. Click a claim of yours to edit it.'
        : 'Drag from the centre outward. Click a claim of yours to edit it.',
  )
  const clamp = (value: number): number =>
    Math.min(model.maxCorners, Math.max(model.minCorners, Math.round(value)))
  const saveLabel = $derived(
    model.template === null
      ? model.editing ? 'Save' : 'Claim'
      : `${model.editing ? 'Save' : 'Claim'} on ${model.template}`,
  )
</script>

<div class="tool" role="toolbar" aria-label="Claim a region">
  <div class="row">
    <div class="shapes" role="group" aria-label="Shape">
      {#each kinds as entry (entry.kind)}
        <Button
          label={entry.label}
          title={entry.key === '' ? entry.label : `${entry.label} (${entry.key})`}
          size="compact"
          kind={model.kind === entry.kind ? 'primary' : 'ghost'}
          pressed={model.kind === entry.kind}
          disabled={model.pending}
          onclick={() => onIntent({ type: 'set-kind', kind: entry.kind })}
        />
      {/each}
    </div>
    {#if model.kind === 'polygon'}
      <label class="count">
        Corners
        <input
          type="number"
          min={model.minCorners}
          max={model.maxCorners}
          value={model.sides}
          disabled={model.pending}
          aria-label="Polygon corners"
          onchange={(event) => onIntent({ type: 'set-sides', sides: clamp(Number(event.currentTarget.value)) })}
        />
      </label>
    {:else if model.kind === 'star'}
      <label class="count">
        Points
        <input
          type="number"
          min={model.minCorners}
          max={model.maxCorners}
          value={model.points}
          disabled={model.pending}
          aria-label="Star points"
          onchange={(event) => onIntent({ type: 'set-points', points: clamp(Number(event.currentTarget.value)) })}
        />
      </label>
    {/if}
    {#if model.drawn}
      <span class="pixels">{model.pixels.toLocaleString()} px</span>
    {/if}
    <div class="actions">
      {#if model.editing}
        <Button label="Delete" size="compact" kind="danger-ghost" disabled={model.pending} onclick={() => onIntent({ type: 'delete' })} />
      {/if}
      <Button label={model.editing ? 'Done' : 'Cancel'} size="compact" kind="ghost" disabled={model.pending} onclick={() => onIntent({ type: 'cancel' })} />
      <Button
        label={saveLabel}
        size="compact"
        kind="primary"
        disabled={!model.drawn || model.template === null || model.pending}
        onclick={() => onIntent({ type: 'claim' })}
      />
    </div>
  </div>
  <p class="hint" role="status">
    {#if model.message}{model.message}{:else if model.drawn && model.template === null}The shape does not touch a server template.{:else}{hint}{/if}
  </p>
</div>

<style>
  .tool {
    box-sizing: border-box;
    max-inline-size: calc(100vw - 2rem);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, 1rem);
    background: var(--caelestis-surface, white);
    color: var(--caelestis-text, #222);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    font: 0.8125rem/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .shapes,
  .actions {
    display: flex;
    gap: 0.25rem;
  }
  .actions {
    margin-inline-start: auto;
  }
  .count {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--caelestis-muted-text);
  }
  .count input {
    inline-size: 3.5rem;
    min-block-size: 2rem;
    padding: 0 0.4rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
  }
  .pixels {
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0.35rem 0 0;
    color: var(--caelestis-muted-text);
    font-size: 0.72rem;
  }
</style>
