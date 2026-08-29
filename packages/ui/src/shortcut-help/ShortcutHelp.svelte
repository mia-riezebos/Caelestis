<script lang="ts">
  import { onMount } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import type { ShortcutHelpIntent, ShortcutHelpModel, ShortcutHelpPlatform } from '../types.js'

  type ShortcutCategory = 'Painting' | 'Overlay'

  interface ShortcutRow {
    readonly key: string
    readonly label: string
  }

  interface ShortcutSet {
    readonly id: string
    readonly category: ShortcutCategory
    readonly title: string
    readonly description: string
    readonly rows: readonly ShortcutRow[]
    readonly keyboardKeys: readonly string[]
  }

  interface KeyboardKey {
    readonly code: string
    readonly legend: string
    readonly width?: number
  }

  let {
    model,
    onIntent,
  }: {
    model: ShortcutHelpModel
    onIntent?: (intent: ShortcutHelpIntent) => void
  } = $props()

  const emit = (intent: ShortcutHelpIntent): void => onIntent?.(intent)
  const sets = $derived(shortcutSetsFor(model.platform))
  const setByKeyboardKey = $derived(
    new Map(sets.flatMap((set) => set.keyboardKeys.map((key) => [key, set] as const))),
  )
  const rows = $derived(keyboardRowsFor(model.platform))

  let dialog: HTMLDialogElement
  let closeControl: HTMLElement
  let map: HTMLElement
  let keyboard: HTMLElement
  let callout: HTMLElement
  let connectors: SVGSVGElement
  let activeSetId = $state<string | null>(null)
  const activeSet = $derived(sets.find((set) => set.id === activeSetId))
  let drawFrame = 0

  const KEY_UNIT_EM = 4
  const KEY_GAP_EM = 0.5
  const keyboardKeyBasis = (units: number): string =>
    `${units * KEY_UNIT_EM + (units - 1) * KEY_GAP_EM}em`

  const drawConnectors = (): void => {
    drawFrame = 0
    connectors.replaceChildren()
    if (activeSetId === null || !map.isConnected) return
    const mapRect = map.getBoundingClientRect()
    const keyboardRect = keyboard.getBoundingClientRect()
    const calloutRect = callout.getBoundingClientRect()
    if (mapRect.width <= 0 || mapRect.height <= 0) return
    connectors.setAttribute('viewBox', `0 0 ${mapRect.width} ${mapRect.height}`)
    const stacked = calloutRect.top >= keyboardRect.bottom - 1
    const anchorX = stacked
      ? calloutRect.left + calloutRect.width / 2 - mapRect.left
      : calloutRect.left - mapRect.left
    const anchorY = stacked
      ? calloutRect.top - mapRect.top
      : calloutRect.top + calloutRect.height / 2 - mapRect.top
    for (const key of Array.from(
      map.querySelectorAll<HTMLElement>(`[data-shortcut-set="${activeSetId}"]`),
    )) {
      const rect = key.getBoundingClientRect()
      const startX = rect.left + rect.width / 2 - mapRect.left
      const startY = rect.top + rect.height / 2 - mapRect.top
      const bendX = stacked ? startX : startX + (anchorX - startX) * 0.58
      const bendY = stacked ? startY + (anchorY - startY) * 0.58 : startY
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${startX} ${startY} L ${bendX} ${bendY} L ${anchorX} ${anchorY}`)
      connectors.appendChild(path)
    }
  }

  const queueConnectors = (): void => {
    if (drawFrame !== 0) cancelAnimationFrame(drawFrame)
    drawFrame = requestAnimationFrame(drawConnectors)
  }

  const inspect = (set: ShortcutSet): void => {
    activeSetId = set.id
    queueConnectors()
  }

  const clear = (set: ShortcutSet, relatedTarget: EventTarget | null): void => {
    if (activeSetId !== set.id) return
    if (
      relatedTarget instanceof HTMLElement &&
      relatedTarget.dataset.shortcutSet === set.id
    ) return
    activeSetId = null
    connectors.replaceChildren()
  }

  onMount(() => {
    if (!dialog.open) dialog.showModal()
    closeControl.querySelector<HTMLButtonElement>('button')?.focus()
    window.addEventListener('resize', queueConnectors)
    return () => {
      if (drawFrame !== 0) cancelAnimationFrame(drawFrame)
      window.removeEventListener('resize', queueConnectors)
    }
  })

  function shortcutSetsFor(platform: ShortcutHelpPlatform): readonly ShortcutSet[] {
    const command = platform === 'mac' ? 'Cmd' : 'Ctrl'
    return [
      {
        id: 'colour-cycle', category: 'Painting', title: 'Cycle unfinished colours',
        description: 'A selects the previous unfinished colour. D selects the next one.',
        rows: [
          { key: 'A', label: 'Previous unfinished colour' },
          { key: 'D', label: 'Next unfinished colour' },
        ],
        keyboardKeys: ['KeyA', 'KeyD'],
      },
      {
        id: 'paint', category: 'Painting', title: 'Open, commit, or cancel a paint draft',
        description: 'B opens Wplace’s paint drawer, then commits its draft. Escape cancels and discards the open draft.',
        rows: [
          { key: 'B', label: 'Open or commit paint draft' },
          { key: 'Esc', label: 'Cancel paint draft' },
        ],
        keyboardKeys: ['KeyB', 'Escape'],
      },
      {
        id: 'pencil', category: 'Painting', title: 'Switch pencil and eraser',
        description: 'E uses Wplace’s own pencil / eraser shortcut while the paint drawer is open.',
        rows: [{ key: 'E', label: 'Pencil / eraser (Wplace)' }], keyboardKeys: ['KeyE'],
      },
      {
        id: 'fly', category: 'Painting', title: 'Jump to the selected colour',
        description: 'F flies to the nearest unfinished pixel of the currently selected colour.',
        rows: [{ key: 'F', label: 'Jump to selected colour' }], keyboardKeys: ['KeyF'],
      },
      {
        id: 'peek', category: 'Painting', title: 'Peek at the map',
        description: 'Hold G to hide the overlays temporarily. Releasing it restores them.',
        rows: [{ key: 'G', label: 'Hold to peek at the map' }], keyboardKeys: ['KeyG'],
      },
      {
        id: 'history', category: 'Painting', title: 'Move through draft history',
        description: `Hold ${command}+Z to undo drafted pixels in recency order. Add Shift to redo them.`,
        rows: [
          { key: `${command}+Z`, label: 'Undo drafted pixels (hold)' },
          { key: `${command}+Shift+Z`, label: 'Redo drafted pixels (hold)' },
        ],
        keyboardKeys: ['ShiftLeft', 'KeyZ', platform === 'mac' ? 'MetaLeft' : 'ControlLeft'],
      },
      {
        id: 'panel', category: 'Overlay', title: 'Open the Caelestis panel',
        description: 'C toggles the main template and settings panel.',
        rows: [{ key: 'C', label: 'Caelestis panel' }], keyboardKeys: ['KeyC'],
      },
      {
        id: 'theme', category: 'Overlay', title: 'Toggle Wplace theme',
        description: 'L switches Wplace between its native light and dark themes.',
        rows: [{ key: 'L', label: 'Light / dark theme' }], keyboardKeys: ['KeyL'],
      },
      {
        id: 'rings', category: 'Overlay', title: 'Toggle contrast rings',
        description: 'R toggles pixel-scaled contrast rings for the focused template or the defaults.',
        rows: [{ key: 'R', label: 'Toggle contrast rings' }], keyboardKeys: ['KeyR'],
      },
      {
        id: 'selected-colour', category: 'Overlay', title: 'Show only the selected colour',
        description: 'S filters the overlay and its contrast rings to the selected palette colour.',
        rows: [{ key: 'S', label: 'Selected colour only' }], keyboardKeys: ['KeyS'],
      },
      {
        id: 'template-menu', category: 'Overlay', title: 'Open template display controls',
        description: 'T opens the display menu for the template nearest the map centre.',
        rows: [{ key: 'T', label: 'Template display menu' }], keyboardKeys: ['KeyT'],
      },
      {
        id: 'visibility', category: 'Overlay', title: 'Toggle template visibility',
        description: 'V shows or hides the focused template.',
        rows: [{ key: 'V', label: 'Template visibility' }], keyboardKeys: ['KeyV'],
      },
      {
        id: 'mismatch-markers', category: 'Overlay', title: 'Toggle mismatch markers',
        description: 'W shows or hides markers on pixels whose painted colour is not the desired one.',
        rows: [{ key: 'W', label: 'Mismatch markers' }], keyboardKeys: ['KeyW'],
      },
      {
        id: 'selected-markers', category: 'Overlay', title: 'Toggle selected-colour markers',
        description: 'X marks unfinished pixels belonging to the selected palette colour.',
        rows: [{ key: 'X', label: 'Selected-colour markers' }], keyboardKeys: ['KeyX'],
      },
      {
        id: 'opacity', category: 'Overlay', title: 'Set overlay opacity',
        description: '1–5 set the focused overlay to 20%, 40%, 60%, 80% or 100% opacity.',
        rows: [{ key: '1–5', label: 'Overlay opacity' }],
        keyboardKeys: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
      },
      {
        id: 'help', category: 'Overlay', title: 'Open keyboard shortcuts',
        description: 'Press ` or the physical Shift+/ chord to open or close this reference.',
        rows: [{ key: '` or Shift+/', label: 'Keyboard shortcuts' }], keyboardKeys: ['Backquote'],
      },
    ]
  }

  function keyboardRowsFor(platform: ShortcutHelpPlatform): readonly (readonly KeyboardKey[])[] {
    return [
      [
        { code: 'Escape', legend: 'Esc', width: 1.25 },
        { code: 'Backquote', legend: '`' }, { code: 'Digit1', legend: '1' },
        { code: 'Digit2', legend: '2' }, { code: 'Digit3', legend: '3' },
        { code: 'Digit4', legend: '4' }, { code: 'Digit5', legend: '5' },
      ],
      [
        { code: 'Tab', legend: 'Tab', width: 1.5 }, { code: 'KeyQ', legend: 'Q' },
        { code: 'KeyW', legend: 'W' }, { code: 'KeyE', legend: 'E' },
        { code: 'KeyR', legend: 'R' }, { code: 'KeyT', legend: 'T' },
      ],
      [
        { code: 'CapsLock', legend: 'Caps', width: 1.75 }, { code: 'KeyA', legend: 'A' },
        { code: 'KeyS', legend: 'S' }, { code: 'KeyD', legend: 'D' },
        { code: 'KeyF', legend: 'F' }, { code: 'KeyG', legend: 'G' },
      ],
      [
        { code: 'ShiftLeft', legend: 'Shift', width: 2.25 }, { code: 'KeyZ', legend: 'Z' },
        { code: 'KeyX', legend: 'X' }, { code: 'KeyC', legend: 'C' },
        { code: 'KeyV', legend: 'V' }, { code: 'KeyB', legend: 'B' },
      ],
      platform === 'mac'
        ? [
            { code: 'ControlLeft', legend: 'Ctrl', width: 1.25 },
            { code: 'AltLeft', legend: 'Opt', width: 1.25 },
            { code: 'MetaLeft', legend: 'Cmd', width: 1.25 },
            { code: 'Space', legend: 'Space', width: 2.5 },
          ]
        : [
            { code: 'ControlLeft', legend: 'Ctrl', width: 1.25 },
            { code: 'MetaLeft', legend: 'Win / Meta', width: 1.25 },
            { code: 'AltLeft', legend: 'Alt', width: 1.25 },
            { code: 'Space', legend: 'Space', width: 2.5 },
          ],
    ]
  }
</script>

<dialog
  bind:this={dialog}
  data-caelestis-shortcut-help
  aria-labelledby="caelestis-shortcut-help-title"
  onclose={() => emit({ type: 'close' })}
  onclick={(event) => { if (event.target === dialog) emit({ type: 'close' }) }}
>
  <div class="caelestis-shortcut-box">
    <header>
      <h2 id="caelestis-shortcut-help-title">Keyboard shortcuts</h2>
      <span bind:this={closeControl}><Button label="Close" kind="ghost" size="small" onclick={() => emit({ type: 'close' })}>Close</Button></span>
    </header>

    <div class="content">
      <div class="caelestis-shortcut-layout">
        <div class="caelestis-shortcut-groups">
          {#each ['Painting', 'Overlay'] as category}
            <section>
              <h3 class="caelestis-shortcut-group-title">{category}</h3>
              <dl class="caelestis-shortcut-list">
                {#each sets.filter((set) => set.category === category).flatMap((set) => set.rows) as row}
                  <dt><kbd>{row.key}</kbd></dt>
                  <dd>{row.label}</dd>
                {/each}
              </dl>
            </section>
          {/each}
        </div>

        <section
          bind:this={map}
          class="caelestis-keymap"
          data-platform={model.platform}
          data-active-set={activeSetId}
          aria-label="Left half of a QWERTY keyboard"
        >
          <div bind:this={keyboard} class="caelestis-keymap-keyboard">
            {#each rows as keys, rowIndex}
              <div class="caelestis-keymap-row" style:--caelestis-key-row={rowIndex}>
                {#each keys as definition (definition.code)}
                  {@const set = setByKeyboardKey.get(definition.code)}
                  {@const units = definition.width ?? 1}
                  {#if set === undefined}
                    <span
                      class="caelestis-keymap-key"
                      data-key-units={units}
                      data-keyboard-key={definition.code}
                      style:--caelestis-key-basis={keyboardKeyBasis(units)}
                      aria-hidden="true"
                    >{definition.legend}</span>
                  {:else}
                    <button
                      type="button"
                      class="caelestis-keymap-key caelestis-keymap-key--bound"
                      data-active={activeSetId === set.id ? '' : undefined}
                      data-key-units={units}
                      data-keyboard-key={definition.code}
                      data-shortcut-set={set.id}
                      style:--caelestis-key-basis={keyboardKeyBasis(units)}
                      aria-label={`${definition.legend}: ${set.title}`}
                      aria-describedby="caelestis-keymap-callout"
                      onpointerenter={() => inspect(set)}
                      onpointerleave={(event) => clear(set, event.relatedTarget)}
                      onfocus={() => inspect(set)}
                      onblur={(event) => clear(set, event.relatedTarget)}
                      onclick={() => inspect(set)}
                    >{definition.legend}</button>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>

          <aside bind:this={callout} id="caelestis-keymap-callout" class="caelestis-keymap-callout" aria-live="polite">
            <p class="caelestis-keymap-callout-hint">Hover, focus or tap a highlighted key.</p>
            <div class="caelestis-keymap-callout-detail">
              {#if activeSet !== undefined}
                <strong>{activeSet.title}</strong>
                <p>{activeSet.description}</p>
              {/if}
            </div>
          </aside>
          <svg bind:this={connectors} class="caelestis-keymap-connectors" aria-hidden="true"></svg>
        </section>
      </div>
      <p class="caelestis-shortcut-note">Shortcuts pause while you are typing in a field.</p>
    </div>
  </div>
</dialog>

<style>
  :global(*) { box-sizing: border-box; }
  dialog { position: fixed; inset: 0; inline-size: 100%; max-inline-size: none; block-size: 100%; max-block-size: none; margin: 0; padding: 0; border: 0; background: transparent; color: var(--caelestis-text); font: 400 0.875rem/1.35 ui-sans-serif, system-ui, sans-serif; }
  dialog[open] { display: grid; place-items: center; }
  dialog::backdrop { background: rgb(0 0 0 / 0.4); }
  .caelestis-shortcut-box { --caelestis-shortcut-max-height: 91.666dvh; display: flex; inline-size: min(91.666vw, 62rem); max-block-size: var(--caelestis-shortcut-max-height); flex-direction: column; overflow: hidden; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-panel-radius, 0.75rem); background: var(--caelestis-surface); box-shadow: var(--caelestis-shadow); }
  header { position: sticky; z-index: 4; inset-block-start: 0; display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; padding: 1rem 1.5rem; border-block-end: 1px solid color-mix(in oklab, var(--caelestis-text) 10%, transparent); background: color-mix(in oklab, var(--caelestis-surface) 88%, transparent); backdrop-filter: blur(12px); }
  h2 { margin: 0; font-size: 1.25rem; font-weight: 700; line-height: 1.4; }
  .content { display: flex; min-block-size: 0; flex: 1; flex-direction: column; overflow-x: hidden; overflow-y: auto; padding: 1rem 1.5rem; }
  .caelestis-shortcut-layout { display: grid; flex: none; grid-template-columns: minmax(20rem, 0.82fr) minmax(27rem, 1.18fr); align-items: stretch; overflow: hidden; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.75rem); background: color-mix(in oklab, var(--caelestis-raised-surface) 58%, transparent); }
  .caelestis-keymap { --tt-in-dur: 150ms; --tt-out-dur: 50ms; --tt-scale: 0.98; --tt-delay: 80ms; position: relative; isolation: isolate; display: grid; flex: none; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(6.75rem, auto); gap: 1.5rem; align-items: center; margin: 0; padding: clamp(1.25rem, 2.5vw, 2rem); border-inline-start: 1px solid var(--caelestis-border); background: color-mix(in oklab, var(--caelestis-surface) 30%, transparent); overflow: hidden; }
  .caelestis-keymap-keyboard { --caelestis-key-gap: 0.5em; position: relative; z-index: 2; display: flex; inline-size: max-content; max-inline-size: 100%; flex-direction: column; gap: var(--caelestis-key-gap); margin-inline: auto; font-size: clamp(0.75rem, 1.35vw, 0.875rem); }
  .caelestis-keymap-row { display: flex; inline-size: max-content; gap: var(--caelestis-key-gap); }
  .caelestis-keymap-key { display: inline-flex; min-inline-size: 0; block-size: 3.5em; flex: 0 0 var(--caelestis-key-basis); align-items: center; justify-content: center; padding: 0 0.25rem; border: 1px solid var(--caelestis-border); border-radius: 0.4rem; background: var(--caelestis-surface); box-shadow: 0 1px 0 var(--caelestis-border), inset 0 -1px 0 color-mix(in oklab, var(--caelestis-text) 8%, transparent); color: var(--caelestis-text); font: 700 1em/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; opacity: 0.3; transition: opacity var(--tt-in-dur) ease-out, transform var(--tt-in-dur) ease-out; }
  button.caelestis-keymap-key { cursor: help; }
  .caelestis-keymap-key--bound { border-color: color-mix(in oklab, var(--caelestis-primary) 55%, transparent); background: color-mix(in oklab, var(--caelestis-primary) 18%, var(--caelestis-surface)); opacity: 1; }
  .caelestis-keymap-key--bound:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  .caelestis-keymap[data-active-set] .caelestis-keymap-key { opacity: 0.14; }
  .caelestis-keymap[data-active-set] .caelestis-keymap-key[data-active] { opacity: 1; transform: translateY(-2px); }
  .caelestis-keymap-callout { position: relative; z-index: 2; display: grid; min-block-size: 5.5rem; align-items: start; margin: 0; padding-block-start: 1.25rem; border-block-start: 1px solid var(--caelestis-border); text-align: center; }
  .caelestis-keymap-callout-hint, .caelestis-keymap-callout-detail { grid-area: 1 / 1; margin: 0; }
  .caelestis-keymap-callout-hint { color: var(--caelestis-muted-text); font-size: 0.8125rem; line-height: 1.25rem; opacity: 1; transition: opacity var(--tt-out-dur) ease-out; }
  .caelestis-keymap-callout-detail { opacity: 0; transform: scale(var(--tt-scale)); transform-origin: 50% 0; text-align: center; transition: opacity var(--tt-out-dur) ease-out, transform var(--tt-out-dur) ease-out; }
  .caelestis-keymap-callout-detail strong { display: block; font-size: 0.875rem; line-height: 1.25rem; }
  .caelestis-keymap-callout-detail p { margin: 0.375rem 0 0; color: var(--caelestis-muted-text); font-size: 0.8125rem; line-height: 1.25rem; }
  .caelestis-keymap[data-active-set] .caelestis-keymap-callout-hint { opacity: 0; }
  .caelestis-keymap[data-active-set] .caelestis-keymap-callout-detail { opacity: 1; transform: scale(1); transition-duration: var(--tt-in-dur); transition-delay: var(--tt-delay); }
  .caelestis-keymap-connectors { position: absolute; z-index: 1; inset: 0; inline-size: 100%; block-size: 100%; color: var(--caelestis-primary); opacity: 0; pointer-events: none; transition: opacity var(--tt-out-dur) ease-out; }
  .caelestis-keymap-connectors :global(path) { fill: none; stroke: currentColor; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .caelestis-keymap[data-active-set] .caelestis-keymap-connectors { opacity: 0.55; transition-duration: var(--tt-in-dur); transition-delay: var(--tt-delay); }
  .caelestis-shortcut-groups { display: grid; flex: none; grid-template-columns: minmax(0, 1fr); gap: 1rem; padding: 1rem; }
  .caelestis-shortcut-groups > section + section { padding-block-start: 1rem; border-block-start: 1px solid var(--caelestis-border); }
  .caelestis-shortcut-group-title { margin: 0 0 0.5rem; color: var(--caelestis-text); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .caelestis-shortcut-list { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 0.25rem 0.75rem; margin: 0; }
  .caelestis-shortcut-list dt, .caelestis-shortcut-list dd { margin: 0; }
  .caelestis-shortcut-list dt { display: flex; justify-content: flex-end; }
  .caelestis-shortcut-list kbd { display: inline-flex; inline-size: fit-content; min-inline-size: 2rem; min-block-size: 1.625rem; align-items: center; justify-content: center; padding-inline: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: 0.375rem; background: var(--caelestis-raised-surface); box-shadow: 0 1px 0 var(--caelestis-border); font: 700 0.75rem/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: nowrap; }
  .caelestis-shortcut-list dd { font-size: 0.875rem; line-height: 1.25rem; }
  .caelestis-shortcut-note { margin-block: 1.25rem 0; color: var(--caelestis-muted-text); font-size: 0.75rem; }
  @media (max-width: 53rem) { .caelestis-shortcut-box { --caelestis-shortcut-max-height: 85dvh; } .caelestis-shortcut-layout { grid-template-columns: 1fr; } .caelestis-keymap { display: none; } }
  @media (prefers-reduced-motion: reduce) { .caelestis-keymap-key, .caelestis-keymap-callout-hint, .caelestis-keymap-callout-detail, .caelestis-keymap-connectors { transition: none !important; } }
</style>
