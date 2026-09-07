import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'

const PREVIEW_EDGE = 256

/** Sample source artwork into a bounded, nearest-neighbour RGBA preview. */
export const previewPixels = (indices: Uint8Array, width: number, height: number) => {
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height))
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4)
  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const index =
        indices[
          Math.floor((y * height) / outputHeight) * width + Math.floor((x * width) / outputWidth)
        ]
      if (index === undefined || index === TRANSPARENT_INDEX) continue
      const colour = WPLACE_PALETTE[index]
      if (colour === undefined) continue
      const offset = (y * outputWidth + x) * 4
      data.set(colour.rgb, offset)
      data[offset + 3] = 255
    }
  }
  return { width: outputWidth, height: outputHeight, data }
}
