/**
 * Each template's opacity ramp.
 *
 * Its own module because two layers need it and neither should import the other. The overlay drives
 * the ramps; the markers only read them — and having the markers reach into the overlay for that,
 * while the overlay reached into the markers for its layer object, was a circular import. The
 * bundler resolves one side of a cycle to a half-initialised module, so `markerLayer` could be
 * `undefined` at the moment the installer touched it.
 *
 * A template arriving is the same event as a template being switched back on, so both come through
 * here. Fading *out* is why the ramps are keyed: a hidden template still has to be drawn, at falling
 * opacity, until its ramp reaches zero, and it leaves the map only once it is invisible.
 */

/** How long a template takes to arrive or leave. */
export const FADE_MS = 500

/** Cubic ease-in-out, the shape CSS `ease-in-out` describes. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

interface Fade {
  /** Where the ramp started, so a fade interrupted midway carries on from where it was. */
  readonly from: number
  readonly to: number
  readonly since: number
}

const fades = new Map<string, Fade>()

/** Advance a ramp towards `target`, and say whether it still has somewhere to go. */
export const fadeOf = (
  id: string,
  target: number,
  now: number,
): { value: number; done: boolean } => {
  const existing = fades.get(id)
  if (existing === undefined) {
    // Never seen: ramp up from nothing, so a restored template arrives rather than appears.
    fades.set(id, { from: 0, to: target, since: now })
    return { value: 0, done: target === 0 }
  }
  const progress = Math.min(Math.max((now - existing.since) / FADE_MS, 0), 1)
  const value = existing.from + (existing.to - existing.from) * ease(progress)
  if (existing.to !== target) {
    // Turned around mid-ramp. Starting the new one from the value on screen is what stops a
    // half-faded template snapping to full before it fades back out.
    fades.set(id, { from: value, to: target, since: now })
    return { value, done: false }
  }
  return { value, done: progress >= 1 }
}

/** Where a ramp currently stands, without advancing it. For anything drawn in another layer. */
export const templateFade = (id: string): number => {
  const fade = fades.get(id)
  if (fade === undefined) return 0
  const progress = Math.min(Math.max((performance.now() - fade.since) / FADE_MS, 0), 1)
  return fade.from + (fade.to - fade.from) * ease(progress)
}

/** Drop ramps for templates that no longer exist. */
export const pruneFades = (keep: ReadonlySet<string>): void => {
  for (const id of [...fades.keys()]) if (!keep.has(id)) fades.delete(id)
}
