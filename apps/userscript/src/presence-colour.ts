import { presenceHue } from '@caelestis/shared'

/** One painter's colour as unit RGB, from the shared hue so every tab agrees on it. */
export const presenceRgb = (wplaceUserId: number): readonly [number, number, number] => {
  const hue = presenceHue(wplaceUserId) / 360
  const saturation = 0.72
  const lightness = 0.55
  const q = lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (t: number): number => {
    const wrapped = ((t % 1) + 1) % 1
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped
    if (wrapped < 1 / 2) return q
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6
    return p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)]
}

/** The same colour as CSS, for labels drawn in the DOM. */
export const presenceCss = (wplaceUserId: number, alpha = 1): string => {
  const [r, g, b] = presenceRgb(wplaceUserId)
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${alpha})`
}
