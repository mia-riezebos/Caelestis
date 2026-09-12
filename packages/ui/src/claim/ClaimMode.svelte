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
        return 'Click selects, Shift-click adds, drag moves, drag empty canvas for a marquee. Corners scale, the grip or just outside a corner rotates.'
      case 'direct':
        return 'Drag any anchor or handle. A rectangle, ellipse, polygon, or star becomes a path as you do.'
      case 'lasso':
        return 'Draw a loop around shapes to select them. Shift adds.'
      case 'hand':
        return 'Drag to pan. Scroll pans, Shift+scroll sideways, Alt or Ctrl+scroll zooms. Space holds the hand from any tool.'
      case 'pen':
        return 'Click for corners, drag for curves. Click the first anchor to close, Enter to finish. On a selected path: an end continues, a segment adds, an anchor deletes.'
      case 'add-anchor':
        return 'Click a segment to add an anchor. The curve does not change.'
      case 'delete-anchor':
        return 'Click an anchor to remove it.'
      case 'anchor':
        return 'Drag out of a corner for handles, click a smooth anchor for a corner, drag one handle to break the pair.'
      case 'pencil':
        return 'Drag to draw pixels. Strokes join the selected drawing.'
      case 'brush':
        return 'Drag to paint a stroke of the chosen width. It stays editable.'
      case 'eraser':
        return 'Drag to erase. Pixels are rubbed out; vector shapes are cut into pieces.'
      default:
        return model.tool === 'rectangle' || model.tool === 'ellipse'
          ? 'Drag corner to corner.'
          : 'Drag from the centre outward.'
    }
  })
  const current = $derived(
    model.tools.find((entry) => entry.tool === model.tool) ?? (model.tools[0] as ClaimToolEntry),
  )
  const hasSubtract = $derived(
    !['select', 'direct', 'lasso', 'hand', 'add-anchor', 'delete-anchor', 'anchor', 'eraser'].includes(model.tool),
  )
  const hasCorners = $derived(model.tool === 'polygon' || model.tool === 'star')
  const hasWidth = $derived(
    model.tool === 'pen' || model.tool === 'pencil' || model.tool === 'brush' || model.tool === 'eraser',
  )
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

  <div class="bar" role="toolbar" aria-label="Claims">
    <div class="row">
      <div class="group tool-group" aria-label="Tool">
        <span class="tool-name"><Icon name={current.icon} size="1rem" />{current.label}</span>
        <div class="options">
          {#if hasCorners}
            <label class="option">
              <span>{model.tool === 'polygon' ? 'Corners' : 'Points'}</span>
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
              <span>Inner %</span>
              <input type="number" min="5" max="95" value={model.options.inner} disabled={model.pending} onchange={(event) => onIntent({ type: 'set-option', option: 'inner', value: clamp(Number(event.currentTarget.value), 5, 95) })} />
            </label>
          {/if}
          {#if hasWidth}
            <label class="option">
              <span>Width</span>
              <input type="number" min={model.tool === 'pen' ? 0 : 1} max={model.options.maxWidth} value={model.options.width} disabled={model.pending} onchange={(event) => onIntent({ type: 'set-option', option: 'width', value: clamp(Number(event.currentTarget.value), model.tool === 'pen' ? 0 : 1, model.options.maxWidth) })} />
            </label>
          {/if}
          {#if hasSubtract}
            <label class="option">
              <Toggle label="Subtract" compact checked={model.subtract} onChange={(subtract) => onIntent({ type: 'set-subtract', subtract })} />
              <span>Subtract</span>
            </label>
          {/if}
        </div>
      </div>

      <div class="group status" aria-label="Claims">
        <span class="count">{model.items} {model.items === 1 ? 'shape' : 'shapes'}</span>
        <span class="dot" aria-hidden="true"></span>
        <span class="count">{model.pixels.toLocaleString()} px</span>
        {#if model.template}<span class="dot" aria-hidden="true"></span><span class="where">on {model.template}</span>{/if}
        <span class="delete" class:hidden={!model.selected}>
          <Button label={deleteLabel} size="compact" kind="ghost" disabled={model.pending || !model.selected} onclick={() => onIntent({ type: 'delete-item' })} />
        </span>
      </div>

      <div class="group actions">
        <span class="unsaved" class:visible={model.dirty} aria-live="polite">{model.dirty ? 'Unsaved' : ''}</span>
        <Button label="Cancel" size="compact" kind="ghost" disabled={model.pending} onclick={() => onIntent({ type: 'cancel' })} />
        <Button label="Save claims" size="compact" kind="primary" disabled={model.pending || !model.dirty} onclick={() => onIntent({ type: 'confirm' })} />
      </div>
    </div>
    <p class="hint" class:message={model.message !== undefined} role="status" title={hint}>{hint}</p>
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
    inline-size: min(64rem, calc(100vw - 8rem));
    padding: 0.5rem 0.75rem 0.45rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, 1rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  /* One row, three groups, one height: the tool and its options, the claims, the actions. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 1rem;
    min-block-size: 2.25rem;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
  }
  .tool-group {
    gap: 0.75rem;
  }
  .tool-name {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: none;
    font-weight: 600;
    white-space: nowrap;
  }
  .options {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-inline-size: 0;
    overflow: hidden;
  }
  .option {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--caelestis-muted-text);
    white-space: nowrap;
  }
  .option input {
    inline-size: 3.25rem;
    block-size: 1.75rem;
    padding: 0 0.4rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .status {
    gap: 0.4rem;
    padding-inline: 0.75rem;
    border-inline: 1px solid var(--caelestis-border);
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .count {
    min-inline-size: 4.5ch;
    text-align: end;
  }
  .where {
    max-inline-size: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    inline-size: 3px;
    block-size: 3px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
  /* The delete control keeps its place whether or not anything is selected. */
  .delete {
    margin-inline-start: 0.25rem;
  }
  .delete.hidden {
    visibility: hidden;
  }
  .actions {
    gap: 0.35rem;
  }
  .unsaved {
    min-inline-size: 4rem;
    color: var(--caelestis-muted-text);
    font-size: 0.72rem;
    text-align: end;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .unsaved.visible {
    opacity: 1;
  }
  /* One line, always the same height; the full text is the title. */
  .hint {
    margin: 0.3rem 0 0;
    block-size: 1.1rem;
    overflow: hidden;
    color: var(--caelestis-muted-text);
    font-size: 0.72rem;
    line-height: 1.1rem;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .hint.message {
    color: var(--caelestis-text);
    font-weight: 500;
  }
</style>
