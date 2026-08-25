import { type Appearance, type PixelStyle, pixelStylePresetOf } from '../templates/appearance.js'
import { FADE_MS, fadeProgress } from './fade.js'

const FIELDS = [
  'size',
  'radius',
  'translateX',
  'translateY',
  'rotation',
  'opacity',
] as const satisfies readonly (keyof PixelStyle)[]

const styleOf = (appearance: Appearance): PixelStyle => ({
  size: appearance.size,
  radius: appearance.radius,
  translateX: appearance.translateX,
  translateY: appearance.translateY,
  rotation: appearance.rotation,
  opacity: appearance.opacity,
})

const sameStyle = (left: PixelStyle, right: PixelStyle): boolean =>
  FIELDS.every((field) => left[field] === right[field])

const interpolate = (from: PixelStyle, to: PixelStyle, progress: number): PixelStyle => ({
  size: from.size + (to.size - from.size) * progress,
  radius: from.radius + (to.radius - from.radius) * progress,
  translateX: from.translateX + (to.translateX - from.translateX) * progress,
  translateY: from.translateY + (to.translateY - from.translateY) * progress,
  rotation: from.rotation + (to.rotation - from.rotation) * progress,
  opacity: from.opacity + (to.opacity - from.opacity) * progress,
})

const withStyle = (appearance: Appearance, style: PixelStyle): Appearance => ({
  ...appearance,
  ...style,
})

interface Transition {
  readonly from: PixelStyle
  readonly target: PixelStyle
  readonly since: number
  readonly moving: boolean
}

export interface AppearanceTransitions {
  readonly advance: (
    id: string,
    target: Appearance,
    now: number,
    reducedMotion?: boolean,
    interactive?: boolean,
  ) => { appearance: Appearance; done: boolean }
  readonly prune: (keep: ReadonlySet<string>) => void
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Tween only the named pixel-style shortcuts; freehand slider adjustments remain under the hand.
 *
 * Retargeting starts from the value currently on screen, so two quick preset clicks never snap back
 * to the first one's endpoint before moving toward the second.
 */
export const appearanceTransitionSet = (): AppearanceTransitions => {
  const transitions = new Map<string, Transition>()

  const valueAt = (transition: Transition, now: number): PixelStyle =>
    transition.moving
      ? interpolate(transition.from, transition.target, fadeProgress(now - transition.since))
      : transition.target

  return {
    advance: (id, target, now, reducedMotion = prefersReducedMotion(), interactive = false) => {
      const next = styleOf(target)
      const existing = transitions.get(id)
      if (existing === undefined) {
        transitions.set(id, { from: next, target: next, since: now, moving: false })
        return { appearance: target, done: true }
      }

      if (!sameStyle(existing.target, next)) {
        const current = valueAt(existing, now)
        const moving = !reducedMotion && (interactive || pixelStylePresetOf(target) !== null)
        transitions.set(id, { from: moving ? current : next, target: next, since: now, moving })
        return { appearance: moving ? withStyle(target, current) : target, done: !moving }
      }

      if (!existing.moving) return { appearance: target, done: true }
      if (now - existing.since >= FADE_MS) {
        transitions.set(id, { from: next, target: next, since: now, moving: false })
        return { appearance: target, done: true }
      }
      return { appearance: withStyle(target, valueAt(existing, now)), done: false }
    },
    prune: (keep) => {
      for (const id of transitions.keys()) if (!keep.has(id)) transitions.delete(id)
    },
  }
}

export const appearanceTransitions = appearanceTransitionSet()
