import { FADE_MS, fadeProgress } from './gl/fade.js'

/** Runtime-only hold-to-peek state. It must never mutate or persist template visibility. */

let active = false
const listeners = new Set<() => void>()
let fade = { from: 1, to: 1, since: 0 }

const opacityAt = (now: number): number =>
  fade.from + (fade.to - fade.from) * fadeProgress(now - fade.since)

export const isOverlayPeekActive = (): boolean => active

/** Shared world and alliance opacity for the held peek transition. */
export const overlayPeekFade = (
  now: number,
): { readonly opacity: number; readonly done: boolean } => ({
  opacity: opacityAt(now),
  done: fade.from === fade.to || now - fade.since >= FADE_MS,
})

export const onOverlayPeekChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Returns whether the render state actually changed. */
export const setOverlayPeekActive = (next: boolean): boolean => {
  if (active === next) return false
  const now = performance.now()
  fade = { from: opacityAt(now), to: next ? 0 : 1, since: now }
  active = next
  for (const listener of listeners) listener()
  return true
}
