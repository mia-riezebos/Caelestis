<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type { ClaimModeIntent, ClaimModeModel, ClaimToolEntry, ClaimToolGroup, ClaimToolGroupId } from '../types.js'

  let { model, onIntent }: { model: ClaimModeModel; onIntent: (intent: ClaimModeIntent) => void } =
    $props()

  /** How long a press on a group button lasts before its flyout opens, like Illustrator. */
  const LONG_PRESS_MS = 400

  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)))
  const hint = $derived.by(() => {
    if (model.message) return model.message
    switch (model.tool) {
      case 'select':
        return 'Click a shape to select it, Shift-click to add, drag to move, drag empty canvas for a marquee. Handles resize or rotate.'
      case 'direct':
        return 'Click a path, then drag its anchors and handles. Drag empty canvas for a marquee.'
      case 'lasso':
        return 'Draw a loop around shapes to select them. Shift adds to the selection.'
      case 'hand':
        return 'Drag to pan. Scroll pans too, Shift+scroll sideways; Alt/Option or Ctrl/Cmd+scroll zooms. Hold Space for the hand from any tool.'
      case 'pen':
        return 'Click to add corners, drag to add curves. Click the first anchor to close, Enter to finish open, Escape to drop the path.'
      case 'pencil':
      case 'brush':
        return 'Drag to draw a stroke.'
      default:
        return model.tool === 'rectangle' || model.tool === 'ellipse'
          ? 'Drag corner to corner. Shapes stay editable with the selection tool.'
          : 'Drag from the centre outward. Shapes stay editable with the selection tool.'
    }
  })
  const hasCorners = $derived(model.tool === 'polygon' || model.tool === 'star')
  const hasWidth = $derived(model.tool === 'pen' || model.tool === 'pencil' || model.tool === 'brush')
  const deleteLabel = $derived(
    model.selectedCount > 1 ? `Delete ${model.selectedCount} shapes` : 'Delete shape',
  )

  const entryFor = (group: ClaimToolGroup): ClaimToolEntry =>
    group.tools.find((entry) => entry.tool === group.shown) ?? (group.tools[0] as ClaimToolEntry)
  const title = (entry: ClaimToolEntry): string =>
    entry.key === '' ? entry.label : `${entry.label} (${entry.key})`

  /** The group whose flyout is open, if any. */
  let open = $state<ClaimToolGroupId | null>(null)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  /** Set once a long press opened the flyout, so the release is not also a click. */
  let pressOpened = false

  const cancelPress = (): void => {
    if (pressTimer !== null) clearTimeout(pressTimer)
    pressTimer = null
  }
  const beginPress = (group: ClaimToolGroup, event: PointerEvent): void => {
    if (event.button !== 0 || group.tools.length < 2) return
    pressOpened = false
    cancelPress()
    pressTimer = setTimeout(() => {
      pressTimer = null
      pressOpened = true
      open = group.id
    }, LONG_PRESS_MS)
  }
  const endPress = (): void => cancelPress()
  const clickGroup = (group: ClaimToolGroup): void => {
    if (pressOpened) {
      pressOpened = false
      return
    }
    open = null
    onIntent({ type: 'set-tool', tool: group.shown })
  }
  const openFlyout = (group: ClaimToolGroup, event: Event): void => {
    event.preventDefault()
    if (group.tools.length < 2) return
    open = open === group.id ? null : group.id
  }
  const pick = (entry: ClaimToolEntry): void => {
    open = null
    onIntent({ type: 'set-tool', tool: entry.tool })
  }
  const onDrawerKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && open !== null) {
      event.stopPropagation()
      open = null
    }
  }
</script>

<div class="mode" aria-label="Claim mode">
  <nav class="drawer" aria-label="Claim tools">
    {#each model.groups as group (group.id)}
      {@const entry = entryFor(group)}
      <div class="slot">
        <button
          type="button"
          class="tool"
          class:active={model.tool === entry.tool || group.tools.some((held) => held.tool === model.tool)}
          class:stacked={group.tools.length > 1}
          title={group.tools.length > 1 ? `${title(entry)} · hold or right-click for more` : title(entry)}
          aria-label={entry.label}
          aria-pressed={group.tools.some((held) => held.tool === model.tool)}
          aria-haspopup={group.tools.length > 1 ? 'menu' : undefined}
          aria-expanded={group.tools.length > 1 ? open === group.id : undefined}
          data-group={group.id}
          disabled={model.pending}
          onpointerdown={(event) => beginPress(group, event)}
          onpointerup={endPress}
          onpointerleave={endPress}
          onpointercancel={endPress}
          onclick={() => clickGroup(group)}
          oncontextmenu={(event) => openFlyout(group, event)}
        >
          <Icon name={entry.icon} size="1.25rem" />
          {#if group.tools.length > 1}<span class="corner" aria-hidden="true"></span>{/if}
        </button>
        {#if open === group.id}
          <div class="flyout" role="menu" tabindex="-1" aria-label={group.label} onkeydown={onDrawerKeydown}>
            {#each group.tools as held (held.tool)}
              <button
                type="button"
                role="menuitemradio"
                class="choice"
                class:active={model.tool === held.tool}
                aria-checked={model.tool === held.tool}
                data-tool={held.tool}
                onclick={() => pick(held)}
              >
                <Icon name={held.icon} size="1.1rem" />
                <span class="choice-label">{held.label}</span>
                {#if held.key !== ''}<kbd>{held.key}</kbd>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
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
          <Button label={deleteLabel} size="compact" kind="ghost" disabled={model.pending} onclick={() => onIntent({ type: 'delete-item' })} />
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
  .slot {
    position: relative;
  }
  .tool {
    position: relative;
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
  .tool:hover:not(:disabled, .active) {
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  .tool.active {
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    color: white;
  }
  /* The active tool stays on its colour under the pointer; a tint of white on a white icon
     would make it vanish. */
  .tool.active:hover:not(:disabled) {
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 88%, black);
  }
  .tool:focus-visible {
    outline: 2px solid var(--caelestis-focus, currentColor);
    outline-offset: -2px;
  }
  /* Illustrator's little triangle: this button hides more tools behind a hold or right-click. */
  .corner {
    position: absolute;
    inset-inline-end: 3px;
    inset-block-end: 3px;
    inline-size: 0;
    block-size: 0;
    border-inline-start: 4px solid transparent;
    border-block-end: 4px solid currentColor;
    opacity: 0.7;
  }
  .flyout {
    position: absolute;
    inset-inline-start: calc(100% + 6px);
    inset-block-start: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 11rem;
    padding: 4px;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    z-index: 1;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border: 0;
    border-radius: calc(var(--caelestis-radius, 0.7rem) - 2px);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .choice:hover:not(.active) {
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  .choice.active {
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    color: white;
  }
  .choice.active:hover {
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 88%, black);
  }
  .choice-label {
    flex: 1;
  }
  .choice kbd {
    font: 0.7rem/1 ui-monospace, monospace;
    opacity: 0.7;
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
