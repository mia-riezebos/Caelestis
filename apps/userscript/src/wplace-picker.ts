import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { log } from './debug.js'
import { canvasPixelAt } from './main.js'
import { pickerIndex, pixelArtIndexAt } from './picker-source.js'
import { stampContains } from './templates/appearance.js'
import { claimedHiddenFor } from './templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, localTemplates } from './templates/local-store.js'
import { sourceXAt } from './templates/placement.js'
import { ensureTilePixels, tilePixels } from './tile-transform.js'
import { isPaintOpen } from './wplace-paint.js'

/**
 * Colour picking, answered from source pixels rather than from the composited canvas.
 *
 * wplace already does this for their own overlays. Their picker samples `pickerPixels` — an
 * `ImageData` their alliance-template worker renders alongside the PNG, purely so the picker has
 * unblended colours to read — and only falls back to the placed pixel when the point misses it:
 *
 *     function Cr(tt){ if(!(r.template?.pickerPixels) || r.template.opacity<=0) return
 *                      ... if(gr.data[Xn+3]!==0) return Ah({r:…,g:…,b:…}) }
 *     function Ur(tt){ const Rt=Cr(tt); … r.onpick?.call(r, tt.x, tt.y, Rt) }
 *
 * Our overlay is not their overlay, so that path never sees it. Worse, their general canvas picker
 * can see every layer in the framebuffer: drafts, hover art and our mismatch marker can all become
 * the colour it quantises. This replaces that path with two unblended sources, in drawing order:
 * our template indices first, then the captured `pixel-art-layer` tile underneath. Draft and marker
 * layers are absent by construction rather than filtered after compositing.
 *
 * "Actually drawing" is the whole subtlety. A pixel whose colour is switched off is a pixel where
 * their canvas is what you can see, so picking there must return *their* placed colour — the filter
 * is a statement about what is shown, and picking should agree with it rather than with the file
 * behind it. Same for the wildcard index and anywhere outside a template.
 *
 * Follow-the-selection is the exception, and it has to be. Under that mode every colour but the one
 * in hand is out of sight, so answering only for what is drawn meant the picker could only ever hand
 * back the colour already selected — it could not be used to *change* colour, which is the whole of
 * what it is for. The mode is a way of looking at one colour at a time, not a claim that the rest of
 * the template is not there, so the pick reads through it.
 */

/**
 * What counts as "on the map".
 *
 * The container as well as the canvas: MapLibre puts markers and their own overlays inside it, and a
 * middle click that lands on one of those is still a click on the map. Our own panel and menus are
 * outside it, which is the distinction being drawn.
 */
const MAP_SURFACE = '.maplibregl-canvas-container, canvas.maplibregl-canvas'

/** The palette index our overlay is drawing at a canvas pixel, or null if it is drawing nothing. */
const overlayIndexAt = (x: number, y: number): number | null => {
  // Last match wins: the layer draws templates in this order, so the last one drawn is the one on
  // top, and the one on top is the one being pointed at.
  let found: number | null = null
  for (const template of localTemplates()) {
    if (!isTemplateVisible(template)) continue
    const localX = sourceXAt(template, x)
    const localY = y - template.originY
    if (localX === null || localY < 0 || localY >= template.height) continue
    const cellX = Math.floor(localX)
    const cellY = Math.floor(localY)
    const index = template.indices[cellY * template.width + cellX]
    if (index === undefined || index === TRANSPARENT_INDEX) continue
    if (claimedHiddenFor(appearanceOf(template)).includes(index)) continue
    if (!stampContains(appearanceOf(template), localX - cellX, localY - cellY)) continue
    found = index
  }
  return found
}

/** The exact base tile index. A cache miss starts a fetch and deliberately returns no colour. */
const placedIndexAt = (x: number, y: number): number | null =>
  pixelArtIndexAt(Math.floor(x), Math.floor(y), (tile) => {
    ensureTilePixels(tile)
    return tilePixels(tile)
  })

/** The colour the picker is allowed to offer at one canvas pixel. */
const pickedIndexAt = (x: number, y: number): number | null =>
  pickerIndex({ template: overlayIndexAt(x, y), pixelArt: placedIndexAt(x, y) })

/**
 * Hand the colour to wplace by pressing its own swatch.
 *
 * Their selection lives in a Svelte store we have no handle on, but every colour has a
 * `<button id="color-N">` that sets it, and clicking one goes through their handler — so the
 * drawer, the brush and anything else watching that store all update the way they would have if the
 * click had been ours. `color-N` is our index plus one, since their array starts at Transparent.
 */
const selectColour = (index: number): boolean => {
  const swatch = document.getElementById(`color-${index + 1}`)
  if (!(swatch instanceof HTMLElement)) return false
  swatch.click()
  return true
}

/**
 * Wplace exposes no picker state, but its rendered control does: the active tool is `btn-primary`.
 * Prefer the visible tooltip label; the icon fallback keeps this working if the label's markup is
 * rearranged while the material-symbol path remains the one Wplace currently ships.
 */
const PICKER_ICON_PREFIX = 'M120-120v-190'

const nativePickerButton = (): HTMLButtonElement | null => {
  for (const tooltip of document.querySelectorAll('.tooltip')) {
    const label = tooltip.querySelector('.tooltip-content')?.textContent ?? ''
    if (!label.includes('Color Picker')) continue
    const button = tooltip.querySelector('button')
    if (button instanceof HTMLButtonElement) return button
  }
  for (const path of document.querySelectorAll('button path')) {
    if (!path.getAttribute('d')?.startsWith(PICKER_ICON_PREFIX)) continue
    const button = path.closest('button')
    if (button instanceof HTMLButtonElement) return button
  }
  return null
}

const nativePickerIsActive = (): boolean =>
  nativePickerButton()?.classList.contains('btn-primary') ?? false

const exitNativePicker = (): void => {
  // Selecting Wplace's own swatch normally schedules the picker to exit. Wait for that Svelte
  // update before deciding whether any work remains: clicking the still-primary, soon-to-be-stale
  // button synchronously races the update and turns the picker back on.
  requestAnimationFrame(() => {
    const button = nativePickerButton()
    if (button?.classList.contains('btn-primary')) button.click()
  })
}

export const installColourPicker = (): void => {
  /**
   * Replace Wplace's left-click pipette before MapLibre receives the click.
   *
   * Its picker listener is on the map container in bubble phase. Capture on `window` therefore
   * wins without patching a Svelte store or MapLibre internals. Once picker mode is active, every
   * map click is swallowed even when the base tile is still loading: falling through on a miss
   * would re-enable the composited sampler and make a draft or mismatch marker pickable again.
   */
  window.addEventListener(
    'click',
    (event) => {
      if (event.button !== 0 || !isPaintOpen() || !nativePickerIsActive()) return
      const target = event.target
      if (!(target instanceof Element) || target.closest(MAP_SURFACE) === null) return

      event.preventDefault()
      event.stopImmediatePropagation()

      const point = canvasPixelAt(event.clientX, event.clientY)
      if (point === null) return
      const { x, y } = point
      const index = pickedIndexAt(x, y)
      if (index === null || !selectColour(index)) {
        log('install', 'picker source pixel is not ready', { x, y })
        return
      }

      // Wplace's swatch normally exits this one-shot tool itself. Check after its render and only
      // use the picker button as a fallback if that state change did not happen.
      exitNativePicker()
      log('install', 'picked a colour from source pixels', { x, y, index })
    },
    { capture: true },
  )

  /**
   * Capture phase, on the window.
   *
   * Their handler is bound to the map canvas, so anything bound there competes on DOM order and
   * whichever ran first would depend on install timing. Capture on the window is unambiguous: it
   * runs on the way down, before the canvas is reached at all, which is the only way to answer a
   * pick *instead of* them rather than after them.
   */
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 1) return
      // Only over their canvas. A middle click on our own panel or menu is not a pick.
      const target = event.target
      if (!(target instanceof Element) || target.closest(MAP_SURFACE) === null) return
      // Their picker only exists inside a painting session, and the swatch we would press only
      // exists while the drawer is open. With it closed there is nothing to hand a colour to.
      if (!isPaintOpen()) return

      const point = canvasPixelAt(event.clientX, event.clientY)
      if (point === null) return
      const index = overlayIndexAt(point.x, point.y)
      if (index === null) return
      if (!selectColour(index)) return

      // Only now, once the colour is actually set. Stopping the event on a pick we then failed to
      // answer would leave the middle click doing nothing at all, which is worse than their answer.
      event.preventDefault()
      event.stopImmediatePropagation()
      log('install', 'picked a colour from the overlay', { x: point.x, y: point.y, index })
    },
    { capture: true },
  )

  // Their own handler does this too. Swallowing the pointerdown means theirs never runs, and
  // without it a middle click on the map starts the browser's autoscroll.
  window.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 1) return
      const target = event.target
      if (target instanceof Element && target.closest(MAP_SURFACE) !== null) {
        event.preventDefault()
      }
    },
    { capture: true },
  )
}
