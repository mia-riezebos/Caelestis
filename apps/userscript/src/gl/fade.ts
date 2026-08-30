/**
 * Opacity ramps, for anything that can be switched on and off.
 *
 * Nothing in the overlay appears or disappears: it arrives and it leaves. That is not decoration —
 * a template, a marker layer and a colour all occupy the same pixels, so a switch that acts
 * instantly gives no clue which of the three moved, and toggling one to find out is exactly what
 * the transition saves you from. Three hundred milliseconds is long enough to see *what* changed
 * and short enough that it never becomes a wait.
 *
 * Its own module because several layers ramp and none should import another. The overlay drives
 * the template ramps; the markers only read them — and having the markers reach into the overlay
 * for that, while the overlay reached into the markers for its layer object, was a circular import.
 * The bundler resolves one side of a cycle to a half-initialised module, so `markerLayer` could be
 * `undefined` at the moment the installer touched it.
 */

/** How long anything takes to arrive or leave. */
export const FADE_MS = 300

/**
 * Cubic ease-in-out: slow to leave, quick through the middle, slow to land.
 *
 * The control points, rather than a keyword, because the same curve has to be evaluated in
 * JavaScript for the ramps below and handed to CSS for anything fading in the DOM — and CSS's own
 * `ease-in-out` is a gentler curve than this one. Sharing the numbers is what keeps a button fading
 * beside its template in step with it.
 */
const CONTROL = [0.65, 0, 0.35, 1] as const

export const FADE_EASING = `cubic-bezier(${CONTROL.join(', ')})`

/** The transition to give a DOM element whose visibility is toggled. */
export const FADE_TRANSITION = `opacity ${FADE_MS}ms ${FADE_EASING}`

/**
 * That bezier, evaluated.
 *
 * A CSS cubic bezier is a curve in two dimensions with its ends pinned to (0,0) and (1,1), so
 * getting `y` for a given time means first solving `x(t) = time` for the parameter. Bisection rather
 * than Newton's method: the curve is monotonic in x by construction, twenty halvings put the answer
 * within a millionth, and this runs a few dozen times a frame at most.
 */
const bezier = (a: number, b: number, at: number): number => {
  const curve = (t: number, p1: number, p2: number): number => {
    const u = 1 - t
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
  }
  let low = 0
  let high = 1
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    if (curve(mid, a, b) < at) low = mid
    else high = mid
  }
  return curve((low + high) / 2, CONTROL[1], CONTROL[3])
}

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : bezier(CONTROL[0], CONTROL[2], t))

/** The shared fade curve at an elapsed duration, for non-opacity motion that must stay in step. */
export const fadeProgress = (elapsedMs: number): number => ease(elapsedMs / FADE_MS)

interface Fade {
  /** Where the ramp started, so a fade interrupted midway carries on from where it was. */
  readonly from: number
  readonly to: number
  readonly since: number
}

export interface Ramps {
  /** Advance a ramp towards `target`, and say whether it still has somewhere to go. */
  readonly advance: (id: string, target: number, now: number) => { value: number; done: boolean }
  /** Where a ramp stands, without advancing it. For anything drawn in another layer. */
  readonly value: (id: string) => number
  /** Drop ramps for things that no longer exist. */
  readonly prune: (keep: ReadonlySet<string>) => void
}

/**
 * A set of ramps, keyed by whatever the caller is fading.
 *
 * Separate sets rather than one shared map, because each is pruned against its own keep-set: the
 * overlay prunes by template id every frame, and a marker ramp keyed by the same id would be swept
 * away by it.
 *
 * `startAt` decides what an unseen ramp is worth on its first frame. `'zero'` makes everything
 * arrive, which is right for the thing itself. `'target'` starts settled, which is right for
 * anything drawn *inside* something that is already arriving — two ramps multiplied together take
 * twice as long to reach full and look like a slower fade rather than a composed one.
 */
export const ramps = ({ startAt = 'zero' }: { startAt?: 'zero' | 'target' } = {}): Ramps => {
  const fades = new Map<string, Fade>()

  const at = (fade: Fade, now: number): number => {
    return fade.from + (fade.to - fade.from) * fadeProgress(now - fade.since)
  }

  return {
    advance: (id, target, now) => {
      const existing = fades.get(id)
      if (existing === undefined) {
        const from = startAt === 'target' ? target : 0
        fades.set(id, { from, to: target, since: now })
        return { value: from, done: from === target }
      }
      const value = at(existing, now)
      if (existing.to !== target) {
        // Turned around mid-ramp. Starting the new one from the value on screen is what stops a
        // half-faded template snapping to full before it fades back out.
        fades.set(id, { from: value, to: target, since: now })
        return { value, done: false }
      }
      return { value, done: (now - existing.since) / FADE_MS >= 1 }
    },
    value: (id) => {
      const fade = fades.get(id)
      return fade === undefined ? 0 : at(fade, performance.now())
    },
    prune: (keep) => {
      for (const id of [...fades.keys()]) if (!keep.has(id)) fades.delete(id)
    },
  }
}

/** Each template's own arrival and departure. Read by the markers, driven by the overlay. */
export const templateFades = ramps()

/**
 * Each template's markers, separately.
 *
 * Switching markers off is not switching the template off, and the two ramp independently: turning
 * markers off while a template arrives should land it fully drawn with nothing marked on it.
 */
export const markerFades = ramps({ startAt: 'target' })

/**
 * The selected-colour guide's palette-index cross-fades.
 *
 * This is separate from `markerFades`: that ramp owns the settings toggle, while these ramps let
 * the old selected colour leave as the new one arrives without changing the toggle's timing.
 */
export const selectedColourMarkerFades = ramps()

/**
 * One ramp per template per palette entry, keyed `<template id>:<index>`.
 *
 * A hidden colour is alpha 0 in the 64×1 palette texture, so fading one is a 256-byte upload rather
 * than a rebuilt bitmap — which is the only reason this is affordable at all. Filtering a colour
 * takes pixels out of the middle of a drawing, and doing that instantly reads as the artwork
 * breaking rather than as a filter being applied.
 */
export const colourFades = ramps({ startAt: 'target' })

/** Each template's contrast outline, independently of the template it surrounds. */
export const outlineFades = ramps({ startAt: 'target' })
