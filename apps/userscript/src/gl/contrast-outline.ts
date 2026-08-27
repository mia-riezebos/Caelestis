/**
 * Map-theme contrast treatment for overlay pixels.
 *
 * WebGL cannot read the colour already in its destination framebuffer without copying that
 * framebuffer into another texture first. Doing that every frame would turn a small legibility fix
 * into a costly full-canvas copy. Wplace does expose the active map theme, though, and its light and
 * dark maps keep their backgrounds in opposite luminance ranges.
 *
 * These thresholds therefore select only the half of the palette most likely to disappear into the
 * active map. The shader applies a sub-pixel black or white inner outline to those colours. It costs
 * no extra texture memory and remains correct when the theme changes.
 */

export const DARK_THEME_LUMA_MAX = 0.47
export const LIGHT_THEME_LUMA_MIN = 0.66

export const srgbLuma = (rgb: readonly [number, number, number]): number =>
  (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255

export const needsContrastOutline = (
  rgb: readonly [number, number, number],
  darkTheme: boolean,
): boolean => {
  const luma = srgbLuma(rgb)
  return darkTheme ? luma <= DARK_THEME_LUMA_MAX : luma >= LIGHT_THEME_LUMA_MIN
}

/** Wplace currently publishes `dark` and `light` on the root element. */
export const isDarkMapTheme = (root: HTMLElement = document.documentElement): boolean => {
  const theme = root.dataset.theme
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return getComputedStyle(root).colorScheme === 'dark'
}
