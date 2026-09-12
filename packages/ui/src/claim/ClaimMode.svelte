<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type { ClaimModeIntent, ClaimModeModel } from '../types.js'

  let { model, onIntent }: { model: ClaimModeModel; onIntent: (intent: ClaimModeIntent) => void } =
    $props()

  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)))
  const hint = $derived.by(() => {
    if (model.message) return model.message
    switch (model.tool) {
      case 'select':
        return 'Click a shape to select it, drag to move it, drag its handles to resize or rotate. Click empty canvas to pan.'
      case 'direct':
        return 'Click a path, then drag its anchors and handles. Click empty canvas to pan.'
      case 'pen':
        return 'Click to add corners, drag to add curves. Click the first anchor to close, Enter to finish open, Escape to drop the path.'
      case 'pencil':
      case 'brush':
        return 'Drag to draw a stroke. The map still zooms.'
      default:
        return model.tool === 'rectangle' || model.tool === 'ellipse'
          ? 'Drag corner to corner. Shapes stay editable with the selection tool.'
          : 'Drag from the centre outward. Shapes stay editable with the selection tool.'
    }
  })
  const hasCorners = $derived(model.tool === 'polygon' || model.tool === 'star')
  const hasWidth = $derived(model.tool === 'pen' || model.tool === 'pencil' || model.tool === 'brush')
</script>

<div class="mode" aria-label="Claim mode">
  <nav class="drawer" aria-label="Claim tools">
    {#each model.tools as entry (entry.tool)}
      <button
        type="button"
        class="tool"
        class:active={model.tool === entry.tool}
        title={entry.key === '' ? entry.label : `${entry.label} (${entry.key})`}
        aria-label={entry.label}
        aria-pressed={model.tool === entry.tool}
        disabled={model.pending}
        onclick={() => onIntent({ type: 'set-tool', tool: entry.tool })}
      >
        <Icon name={entry.icon} size="1.25rem" />
      </button>
    {/each}
  </nav>

  <div class="bar" role="toolbar" aria-label="Claim">
    <div class="row">
      <strong class="title">{model.editing ? 'Edit claim' : 'New claim'}</strong>
      {#if hasCorners}
        <label class="option">
          {model.tool === 'polygon' ? 'Corners' : 'Points'}
          <input
            type="number"
            min={model.options.minCorners}
            max={model.options.maxCorners}
            value={model.tool === 'polygon' ? model.options.sides : model.options.points}
            disabled={model.pending}
            onchange={(event) => onIntent({ type: 'set-option', option: model.tool === 'polygon' ? 'sides' : 'points', value: clamp(Number(event.currentTarget.value), model.options.minCorners, model.options.maxCorners) })}
          />
        </label>
      {/if}
      {#if model.tool === 'star'}
        <label class="option">
          Inner %
          <input type="number" min="5" max="95" value={model.options.inner} disabled={model.pending} onchange={(event) => onIntent({ type: 'set-option', option: 'inner', value: clamp(Number(event.currentTarget.value), 5, 95) })} />
        </label>
      {/if}
      {#if hasWidth}
        <label class="option">
          Width
          <input type="number" min={model.tool === 'pen' ? 0 : 1} max={model.options.maxWidth} value={model.options.width} disabled={model.pending} onchange={(event) => onIntent({ type: 'set-option', option: 'width', value: clamp(Number(event.currentTarget.value), model.tool === 'pen' ? 0 : 1, model.options.maxWidth) })} />
        </label>
      {/if}
      <label class="option">
        <Toggle label="Subtract" compact checked={model.subtract} onChange={(subtract) => onIntent({ type: 'set-subtract', subtract })} />
        Subtract
      </label>
      <span class="stats">{model.items} {model.items === 1 ? 'shape' : 'shapes'} · {model.pixels.toLocaleString()} px{#if model.template} · on {model.template}{/if}</span>
      <div class="actions">
        {#if model.selected}
          <Button label="Delete shape" size="compact" kind="ghost" disabled={model.pending} onclick={() => onIntent({ type: 'delete-item' })} />
        {/if}
        {#if model.editing}
          <Button label="Delete claim" size="compact" kind="danger-ghost" disabled={model.pending} onclick={() => onIntent({ type: 'delete-claim' })} />
        {/if}
        <Button label="Cancel" size="compact" kind="ghost" disabled={model.pending} onclick={() => onIntent({ type: 'cancel' })} />
        <Button label={model.editing ? 'Save' : 'Confirm'} size="compact" kind="primary" disabled={model.items === 0 || model.pending} onclick={() => onIntent({ type: 'confirm' })} />
      </div>
    </div>
    <p class="hint" role="status">{hint}</p>
  </div>
</div>

<style>
  .mode {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font: 0.8125rem/1.4 ui-sans-serif, system-ui, sans-serif;
    color: var(--caelestis-text, #222);
  }
  .drawer {
    position: absolute;
    inset-inline-start: 12px;
    inset-block-start: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, 1rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .tool {
    display: grid;
    place-items: center;
    inline-size: 2.25rem;
    block-size: 2.25rem;
    border: 0;
    border-radius: calc(var(--caelestis-radius, 0.7rem) - 2px);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .tool:hover:not(:disabled) {
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  .tool.active {
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    color: white;
  }
  .tool:focus-visible {
    outline: 2px solid var(--caelestis-focus, currentColor);
    outline-offset: -2px;
  }
  .bar {
    position: absolute;
    inset-block-start: 12px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    box-sizing: border-box;
    max-inline-size: calc(100vw - 6rem);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, 1rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .title {
    font-weight: 600;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--caelestis-muted-text);
  }
  .option input {
    inline-size: 3.5rem;
    min-block-size: 2rem;
    padding: 0 0.4rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
  }
  .stats {
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    gap: 0.25rem;
    margin-inline-start: auto;
  }
  .hint {
    margin: 0.35rem 0 0;
    color: var(--caelestis-muted-text);
    font-size: 0.72rem;
  }
</style>
