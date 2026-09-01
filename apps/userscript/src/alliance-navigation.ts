import { allianceBounds } from './alliance-coordinates.js'
import type { ActiveAllianceSurface } from './alliance-surface.js'

const MAX_ARTBOARD_SCALE = 64
const WHEEL_STEP = 100

/**
 * Centre one alliance pixel through Wplace's own artboard transform without changing its zoom.
 *
 * Wplace scales by 1.2 for a 100-pixel wheel step. Zooming at a calculated pivot and immediately
 * applying the inverse step at the viewport centre leaves the scale unchanged and translates the
 * artboard by the requested screen delta. Both events run in one task, so no intermediate zoom is
 * painted.
 */
export const navigateAllianceArtboardTo = (
  active: ActiveAllianceSurface,
  target: { readonly x: number; readonly y: number },
): boolean => {
  const bounds = allianceBounds(active)
  if (bounds === null) return false
  const stage = active.stage.getBoundingClientRect()
  const frame = active.frame.getBoundingClientRect()
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (stage.width <= 0 || stage.height <= 0 || frame.width <= 0 || frame.height <= 0) return false

  const centre = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 }
  const screen = {
    x: frame.left + ((target.x - bounds.minX) / width) * frame.width,
    y: frame.top + ((target.y - bounds.minY) / height) * frame.height,
  }
  const shift = { x: centre.x - screen.x, y: centre.y - screen.y }
  if (Math.abs(shift.x) < 0.5 && Math.abs(shift.y) < 0.5) return true

  const scale = Math.max(frame.width / width, frame.height / height)
  const zoomInFirst = scale < MAX_ARTBOARD_SCALE
  const factor = zoomInFirst ? 1 / 6 : -1 / 5
  const pivot = {
    x: centre.x - shift.x / factor,
    y: centre.y - shift.y / factor,
  }
  const wheel = (point: { readonly x: number; readonly y: number }, deltaY: number): void => {
    active.stage.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      }),
    )
  }
  wheel(pivot, zoomInFirst ? -WHEEL_STEP : WHEEL_STEP)
  wheel(centre, zoomInFirst ? WHEEL_STEP : -WHEEL_STEP)
  return true
}
