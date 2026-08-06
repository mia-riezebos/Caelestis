import { TILE_SIZE, tileKey } from '@wts/shared'
import { installDebugApi, log } from './debug.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'

/**
 * Entry point.
 *
 * Today this is a visual proof of the render path rather than the render path itself: it draws a
 * black square on **one named tile**, on a canvas of ours stacked over MapLibre's, leaving wplace's
 * own pixels untouched underneath. What it demonstrates is the part that was in doubt — that we can
 * place our own pixels in exact tile coordinates without compositing into wplace's tiles, and so
 * without giving up the per-colour toggles and view modes that need our pixels to stay separately
 * addressable.
 *
 * Still to come: fetching each connected server's manifest and drawing the chunk that covers a tile
 * instead of a square.
 */

/** The one tile the demo paints. Its centre is 52.429222, 5.009766. */
const DEMO_TILE = tileKey({ x: 1052, y: 672 })

/** Fraction of the tile the demo square covers, centred. */
const SQUARE_SCALE = 1 / 2

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

let lastReported = -1

const draw = ({ canvas: mapCanvas, quads }: TileFrame): void => {
  const canvas = overlayCanvas()
  if (canvas.parentElement === null) mapCanvas.parentElement?.appendChild(canvas)
  if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
    canvas.width = mapCanvas.width
    canvas.height = mapCanvas.height
  }

  const context = canvas.getContext('2d')
  if (context === null) return
  // Cleared unconditionally, including on frames with no tiles at all. Without that, zooming out
  // past the point where wplace stops serving tiles would strand the last frame's squares on screen
  // over a map that no longer has anything under them.
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000000'

  const mine = quads.filter((quad) => tileKey(quad.tile) === DEMO_TILE)
  const inset = (1 - SQUARE_SCALE) / 2
  for (const quad of mine) {
    context.fillRect(
      quad.x + quad.width * inset,
      quad.y + quad.height * inset,
      quad.width * SQUARE_SCALE,
      quad.height * SQUARE_SCALE,
    )
  }

  log('draw', `painted ${mine.length}`, {
    onScreen: quads.map((quad) => tileKey(quad.tile)).join(' ') || '(none)',
    target: DEMO_TILE,
    rects:
      mine
        .map((q) => `${Math.round(q.x)},${Math.round(q.y)} ${Math.round(q.width)}px`)
        .join(' | ') || '(none)',
  })

  if (mine.length !== lastReported) {
    lastReported = mine.length
    const identified = quads.map((quad) => tileKey(quad.tile)).join(' ')
    console.info(
      `[wts] ${quads.length} tiles on screen [${identified}] — drawing ${mine.length} on ${DEMO_TILE}`,
    )
  }
}

const main = (): void => {
  installDebugApi({ demoTile: DEMO_TILE })
  install()
  onTileFrame(draw)
  console.info(`[wts] loaded — tile size ${TILE_SIZE}, watching MapLibre for tile transforms`)
}

main()
