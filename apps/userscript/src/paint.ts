import type { TileFrame } from './tile-transform.js'

export type FramePainter = (context: CanvasRenderingContext2D, frame: TileFrame) => void

/** Clear the overlay and run its registered painters in order. */
export const paintFrame = (
  context: CanvasRenderingContext2D,
  frame: TileFrame,
  painters: readonly FramePainter[],
): void => {
  const { canvas } = context
  context.reset()
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (const painter of painters) {
    context.save()
    try {
      painter(context, frame)
    } finally {
      context.restore()
    }
  }
}
