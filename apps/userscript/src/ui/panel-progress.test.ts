// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { canvasWritesTouchFrame } from './panel-progress.js'

it('keeps a relevant artboard write when an unrelated canvas follows in the same batch', () => {
  const frame = document.createElement('div')
  const artboard = document.createElement('canvas')
  const unrelated = document.createElement('canvas')
  frame.append(artboard)

  expect(canvasWritesTouchFrame(frame, new Set([artboard, unrelated]))).toBe(true)
})
