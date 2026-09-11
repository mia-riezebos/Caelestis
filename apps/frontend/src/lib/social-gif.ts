import gifenc from 'gifenc/dist/gifenc.js'

export const HISTORY_PLAYBACK_SECONDS = 10
const GIF_TICK_MS = 10
const LIVE_PAUSE_MS = 5000
const MAX_GIF_BYTES = 4_500_000
const { applyPalette, GIFEncoder, quantize } = gifenc

function encodeFrames(frames: readonly Uint8Array[], width: number, height: number) {
  const gif = GIFEncoder()
  const historyFrames = frames.length - 1
  const historyTicks = (HISTORY_PLAYBACK_SECONDS * 1000) / GIF_TICK_MS
  let previous: Uint8Array | undefined
  let pending:
    | {
        indices: Uint8Array
        width: number
        height: number
        palette?: number[][]
        delay: number
        transparent: boolean
        transparentIndex: number
      }
    | undefined
  const flush = () => {
    if (!pending) return
    gif.writeFrame(pending.indices, pending.width, pending.height, {
      ...pending,
      repeat: 0,
      // Transparent pixels retain the previous canvas, including its map and attribution.
      dispose: 1,
    })
  }
  for (const [index, frame] of frames.entries()) {
    const final = index === historyFrames
    const delay = final
      ? LIVE_PAUSE_MS
      : (Math.ceil(((index + 1) * historyTicks) / historyFrames) -
          Math.ceil((index * historyTicks) / historyFrames)) *
        GIF_TICK_MS
    const changed = new Uint8Array(width * height)
    let hasChanges = !previous
    if (previous) {
      for (let pixel = 0; pixel < changed.length; pixel++) {
        const offset = pixel * 4
        if (
          frame[offset] === previous[offset] &&
          frame[offset + 1] === previous[offset + 1] &&
          frame[offset + 2] === previous[offset + 2]
        )
          continue
        changed[pixel] = 1
        hasChanges = true
      }
    }
    if (!hasChanges && pending && !final) {
      pending.delay += delay
      continue
    }
    flush()
    if (!hasChanges) {
      // Keep the final hold explicit without encoding another full, identical canvas.
      pending = {
        indices: new Uint8Array(1),
        width: 1,
        height: 1,
        delay,
        transparent: true,
        transparentIndex: 0,
      }
    } else {
      // gifenc reads the whole backing buffer, ignoring a view's offset and length.
      const rgba =
        frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
          ? frame
          : new Uint8Array(frame)
      const palette = quantize(rgba, 128)
      const indices = applyPalette(rgba, palette)
      const transparentIndex = palette.length
      if (previous) {
        for (let pixel = 0; pixel < indices.length; pixel++) {
          if (!changed[pixel]) indices[pixel] = transparentIndex
        }
        // Reserve transparency after quantization so all 128 artwork colors remain available.
        palette.push([0, 0, 0])
      }
      pending = {
        indices,
        width,
        height,
        palette,
        delay,
        transparent: !!previous,
        transparentIndex,
      }
    }
    previous = frame
  }
  flush()
  gif.finish()
  return gif.bytes()
}

/** Encode opaque canvases as ten seconds of history and a five-second final hold, looping forever. */
export function encodeTimelapseGif(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
): Uint8Array {
  let selected = frames
  while (true) {
    const bytes = encodeFrames(selected, width, height)
    if (bytes.length <= MAX_GIF_BYTES) return bytes
    if (selected.length <= 3) throw new Error('Timelapse exceeds the share image size limit')
    selected = [...selected.slice(0, -2).filter((_, i) => i % 2 === 0), ...selected.slice(-2)]
  }
}
