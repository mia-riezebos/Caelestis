import { TILE_SIZE } from '@wts/shared'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'

/**
 * Entry point.
 *
 * Today this is a visual proof of the render path rather than the render path itself: it draws a
 * black square in the middle of every wplace tile on screen, on a canvas of our own stacked over
 * MapLibre's. What it demonstrates is the part that was in doubt — that we can place our own pixels
 * in exact tile coordinates without compositing into wplace's tiles, and so without giving up the
 * per-colour toggles and view modes that need our pixels to stay separately addressable.
 *
 * Still to come: fetching each connected server's manifest, resolving which chunk covers which
 * tile, and drawing that chunk instead of a square.
 */

/** Fraction of the tile the demo square covers, centred. */
const SQUARE_SCALE = 1 / 3

const overlayCanvas = (): HTMLCanvasElement => {
  const existing = document.querySelector<HTMLCanvasElement>('canvas[data-wts-overlay]')
  if (existing !== null) return existing
  const canvas = document.createElement('canvas')
  canvas.dataset.wtsOverlay = ''
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // The map has to stay draggable through us.
  canvas.style.pointerEvents = 'none'
  return canvas
}

const draw = ({ canvas: mapCanvas, quads }: TileFrame): void => {
  const canvas = overlayCanvas()
  if (canvas.parentElement === null) mapCanvas.parentElement?.appendChild(canvas)
  if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
    canvas.width = mapCanvas.width
    canvas.height = mapCanvas.height
  }

  const context = canvas.getContext('2d')
  if (context === null) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000000'

  const inset = (1 - SQUARE_SCALE) / 2
  for (const quad of quads) {
    context.fillRect(
      quad.x + quad.width * inset,
      quad.y + quad.height * inset,
      quad.width * SQUARE_SCALE,
      quad.height * SQUARE_SCALE,
    )
  }

  console.info(`[wts] drew ${quads.length} tile squares`)
}

const main = (): void => {
  install()
  onTileFrame(draw)
  console.info(`[wts] loaded — tile size ${TILE_SIZE}, watching MapLibre for tile transforms`)
}

main()
