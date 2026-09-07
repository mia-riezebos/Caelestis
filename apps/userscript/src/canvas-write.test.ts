import { afterEach, expect, it } from 'vitest'
import { announceCanvasWrite } from './canvas-write.js'
import { profileSnapshot, setProfileEnabled } from './profile.js'

afterEach(() => setProfileEnabled(false))

it.each([
  [{ x: -10, y: -20, width: 25, height: 40 }, 300],
  [{ x: 10, y: 10, width: -3, height: 2 }, 6],
  [{ x: 0, y: 0, width: 2_000, height: 2_000 }, 1_000_000],
  [{ x: 1_100, y: 0, width: 10, height: 10 }, 0],
])('counts only the canvas intersection of %j', (rect, pixels) => {
  setProfileEnabled(true)
  announceCanvasWrite({ width: 1_000, height: 1_000 }, rect)
  expect(profileSnapshot().counters['canvas:written pixels']).toBe(pixels)
  expect(profileSnapshot().counters['canvas:observed writes']).toBe(1)
})
