/**
 * Opacity ramps, for anything that can be switched on and off.
 *
 * Nothing in the overlay appears or disappears: it arrives and it leaves. That is not decoration —
 * a template, a marker layer and a colour all occupy the same pixels, so a switch that acts
 * instantly gives no clue which of the three moved, and toggling one to find out is exactly what
 * the transition saves you from. Half a second is long enough to see *what* changed and short
 * enough that it never becomes a wait.
 *
 * Its own module because several layers ramp and none should import another. The overlay drives
 * the template ramps; the markers only read them — and having the markers reach into the overlay
 * for that, while the overlay reached into the markers for its layer object, was a circular import.
 * The bundler resolves one side of a cycle to a half-initialised module, so `markerLayer` could be
 * `undefined` at the moment the installer touched it.
 */

/** How long anything takes to arrive or leave. */
export const FADE_MS = 500

/**
 * The same curve, for the DOM.
 *
 * CSS `ease-in-out` is not the cubic below — it is a gentler bezier — so a button fading beside a
 * template it belongs to would drift out of step with it over half a second, which is long enough
 * to see. This is the cubic written as a bezier.
 */
export const FADE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)'

/** The transition to give a DOM element whose visibility is toggled. */
export const FADE_TRANSITION = `opacity ${FADE_MS}ms ${FADE_EASING}`

/** Cubic ease-in-out: slow to leave, slow to land, quick through the middle. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

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
    const progress = Math.min(Math.max((now - fade.since) / FADE_MS, 0), 1)
    return fade.from + (fade.to - fade.from) * ease(progress)
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
 * One ramp per template per palette entry, keyed `<template id>:<index>`.
 *
 * A hidden colour is alpha 0 in the 64×1 palette texture, so fading one is a 256-byte upload rather
 * than a rebuilt bitmap — which is the only reason this is affordable at all. Filtering a colour
 * takes pixels out of the middle of a drawing, and doing that instantly reads as the artwork
 * breaking rather than as a filter being applied.
 */
export const colourFades = ramps({ startAt: 'target' })
