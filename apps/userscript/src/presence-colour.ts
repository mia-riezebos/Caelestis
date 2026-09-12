import { presenceColour } from '@caelestis/shared'

/** One painter's colour as unit RGB, from the shared named list so every tab agrees on it. */
export const presenceRgb = (wplaceUserId: number): readonly [number, number, number] => {
  const [r, g, b] = presenceColour(wplaceUserId).rgb
  return [r / 255, g / 255, b / 255]
}

/** The same colour as CSS, for labels drawn in the DOM. */
export const presenceCss = (wplaceUserId: number, alpha = 1): string => {
  const [r, g, b] = presenceColour(wplaceUserId).rgb
  return `rgb(${r} ${g} ${b} / ${alpha})`
}
