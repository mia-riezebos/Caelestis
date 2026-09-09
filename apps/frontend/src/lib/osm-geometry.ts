import { WORLD_PIXELS } from '@caelestis/shared'

export const OSM_TILE_SIZE = 256

/** Choose map detail to match the number of screen pixels per canvas pixel. */
export const osmZoomFor = (scale: number, minZoom = 6): number =>
  Math.min(
    16,
    Math.max(minZoom, Math.round(Math.log2(scale) + Math.log2(WORLD_PIXELS / OSM_TILE_SIZE))),
  )

/** Canvas pixels one OSM tile covers at zoom z. */
export const osmSpan = (z: number): number => WORLD_PIXELS / 2 ** z
