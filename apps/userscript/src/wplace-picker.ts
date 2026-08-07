import { TRANSPARENT_INDEX } from '@wts/shared'
import { log } from './debug.js'
import { canvasPixelAt } from './main.js'
import { claimedHiddenFor } from './templates/colour-filter.js'
import { isTemplateVisible, localTemplates } from './templates/local-store.js'
import { isPaintOpen } from './wplace-paint.js'

/**
 * Middle-click colour picking, answered from the template rather than from the canvas.
 *
 * wplace already does this for their own overlays. Their picker samples `pickerPixels` — an
 * `ImageData` their alliance-template worker renders alongside the PNG, purely so the picker has
 * unblended colours to read — and only falls back to the placed pixel when the point misses it:
 *
 *     function Cr(tt){ if(!(r.template?.pickerPixels) || r.template.opacity<=0) return
 *                      ... if(gr.data[Xn+3]!==0) return Ah({r:…,g:…,b:…}) }
 *     function Ur(tt){ const Rt=Cr(tt); … r.onpick?.call(r, tt.x, tt.y, Rt) }
 *
 * Our overlay is not their overlay, so that path never sees it and picking over one of our templates
 * returns whatever is painted underneath. This adds the same courtesy for ours, and the fallback
 * rule is theirs: only answer for a pixel we are actually drawing.
 *
 * "Actually drawing" is the whole subtlety. A pixel whose colour is switched off is a pixel where
 * their canvas is what you can see, so picking there must return *their* colour — the filter is a
 * statement about what is shown, and picking should agree with the screen rather than with the file
 * behind it. Same for the wildcard index, which asks for no colour at all, and for anywhere outside
 * a template. In all three the event is left alone and wplace answers it.
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
const drawnIndexAt = (x: number, y: number): number | null => {
  // Last match wins: the layer draws templates in this order, so the last one drawn is the one on
  // top, and the one on top is the one being pointed at.
  let found: number | null = null
  for (const template of localTemplates()) {
    if (!isTemplateVisible(template)) continue
    const localX = x - template.originX
    const localY = y - template.originY
    if (localX < 0 || localY < 0 || localX >= template.width || localY >= template.height) continue
    const index = template.indices[localY * template.width + localX]
    if (index === undefined || index === TRANSPARENT_INDEX) continue
    if (claimedHiddenFor(template.appearance).includes(index)) continue
    found = index
  }
  return found
}

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

export const installColourPicker = (): void => {
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
      const index = drawnIndexAt(Math.floor(point.x), Math.floor(point.y))
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
