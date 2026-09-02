import { type TemplateSurface, TRANSPARENT_INDEX, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { allianceBounds, alliancePointAt } from './alliance-coordinates.js'
import { type ActiveAllianceSurface, activeAllianceSurface } from './alliance-surface.js'
import { log } from './debug.js'
import { artboardPixelIndexAt, readArtboardPixels } from './gl/artboard-pixels.js'
import { canvasPixelAt } from './main.js'
import { pickerIndex, pixelArtIndexAt } from './picker-source.js'
import { claimedHiddenFor } from './templates/colour-filter.js'
import {
  appearanceOf,
  displayTemplatesForSurface,
  isTemplateVisible,
} from './templates/local-store.js'
import { sourceXAt } from './templates/placement.js'
import { ensureTilePixels, tilePixels } from './tile-transform.js'
import { isPaintOpen, selectPaintColour } from './wplace-paint.js'

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
 * Stamp geometry is different. Size, rounding, offset and rotation change how a source cell is
 * drawn, but the transparent space they leave inside that cell still belongs to the same template
 * pixel. The picker therefore resolves the whole logical cell and never tests the rendered stamp.
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

/** The palette index our overlay claims at a logical canvas pixel, or null if it claims none. */
const overlayIndexAt = (surface: TemplateSurface, x: number, y: number): number | null => {
  // Last match wins: the layer draws templates in this order, so the last one drawn is the one on
  // top, and the one on top is the one being pointed at.
  let found: number | null = null
  for (const template of displayTemplatesForSurface(surface)) {
    if (!isTemplateVisible(template)) continue
    const localX = sourceXAt(template, x)
    const localY = y - template.originY
    if (localX === null || localY < 0 || localY >= template.height) continue
    const cellX = Math.floor(localX)
    const cellY = Math.floor(localY)
    const index = template.indices[cellY * template.width + cellX]
    if (index === undefined || index === TRANSPARENT_INDEX) continue
    if (claimedHiddenFor(appearanceOf(template)).includes(index)) continue
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
interface PickerPoint {
  readonly surface: TemplateSurface
  readonly x: number
  readonly y: number
  readonly alliance: ActiveAllianceSurface | null
}

const pickerPointAt = (target: Element, clientX: number, clientY: number): PickerPoint | null => {
  const alliance = activeAllianceSurface()
  if (alliance?.frame.contains(target)) {
    const point = alliancePointAt(alliance, clientX, clientY)
    return point === null ? null : { surface: alliance.surface, ...point, alliance }
  }
  if (target.closest(MAP_SURFACE) === null) return null
  const point = canvasPixelAt(clientX, clientY)
  return point === null ? null : { surface: WORLD_TEMPLATE_SURFACE, ...point, alliance: null }
}

const pickedIndexAt = ({ surface, x, y, alliance }: PickerPoint): number | null => {
  const template = overlayIndexAt(surface, x, y)
  if (alliance === null) return pickerIndex({ template, pixelArt: placedIndexAt(x, y) })
  const bounds = allianceBounds(alliance)
  if (bounds === null) return template
  const regions = readArtboardPixels(alliance, {
    originX: bounds.minX,
    originY: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  })
  return pickerIndex({ template, pixelArt: artboardPixelIndexAt(regions, x, y) })
}

/**
 * Wplace exposes no picker state, but its rendered control does: the active tool is `btn-primary`.
 * Prefer the visible tooltip label; the icon fallback keeps this working if the label's markup is
 * rearranged while the material-symbol path remains the one Wplace currently ships.
 */
const PICKER_ICON_PREFIX = 'M120-120v-190'

const nativePickerButton = (): HTMLButtonElement | null => {
  const labelled = document.querySelector<HTMLButtonElement>('button[aria-label="Color Picker"]')
  if (labelled !== null) return labelled
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
  // World painting exits the picker when its swatch changes. Alliance painting does not, and its
  // picker button is not a toggle. Toggling the native eraser on and back off is the public route
  // to the neutral brush tool, so use it only if Wplace still has the picker active after rendering.
  requestAnimationFrame(() => {
    const button = nativePickerButton()
    if (!button?.classList.contains('btn-primary')) return
    const root = button.closest('dialog[open]') ?? document
    const eraser = root.querySelector<HTMLButtonElement>('button[aria-label="Eraser"]')
    if (eraser === null) return
    eraser.click()
    requestAnimationFrame(() => {
      const current = root.querySelector<HTMLButtonElement>('button[aria-label="Eraser"]')
      if (current?.getAttribute('aria-pressed') === 'true') current.click()
    })
  })
}

export const installColourPicker = (): void => {
  let pendingLeftPick: { readonly x: number; readonly y: number; readonly until: number } | null =
    null

  /**
   * Replace Wplace's left-click pipette before Wplace handles the pointer sequence.
   *
   * Wplace now ends picker mode during pointer handling, before the later `click` reaches our old
   * capture listener. Capturing `pointerdown` on `window` preserves the active-tool signal and wins
   * without patching a Svelte store. The matching click is swallowed below so Wplace cannot run its
   * composited fallback after we have answered from source pixels.
   */
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !isPaintOpen() || !nativePickerIsActive()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const point = pickerPointAt(target, event.clientX, event.clientY)
      if (point === null) return

      event.preventDefault()
      event.stopImmediatePropagation()
      pendingLeftPick = { x: event.clientX, y: event.clientY, until: performance.now() + 1_000 }

      const { x, y } = point
      const index = pickedIndexAt(point)
      if (index === null || !selectPaintColour(index)) {
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

  window.addEventListener(
    'click',
    (event) => {
      const pending = pendingLeftPick
      pendingLeftPick = null
      if (
        pending === null ||
        event.button !== 0 ||
        performance.now() > pending.until ||
        Math.abs(event.clientX - pending.x) > 4 ||
        Math.abs(event.clientY - pending.y) > 4
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
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
      const target = event.target
      if (!(target instanceof Element)) return
      const point = pickerPointAt(target, event.clientX, event.clientY)
      if (point === null) return
      // Their picker only exists inside a painting session, and the swatch we would press only
      // exists while the drawer is open. With it closed there is nothing to hand a colour to.
      if (!isPaintOpen()) return

      const index = overlayIndexAt(point.surface, point.x, point.y)
      if (index === null) return
      if (!selectPaintColour(index)) return

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
      if (
        target instanceof Element &&
        pickerPointAt(target, event.clientX, event.clientY) !== null
      ) {
        event.preventDefault()
      }
    },
    { capture: true },
  )
}
