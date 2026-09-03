// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { canvasWritesTouchArtboard, canvasWriteTouchesArtboard } from './panel-progress.js'

it('keeps a relevant artboard write when an unrelated canvas follows in the same batch', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const artboard = document.createElement('canvas')
  const unrelated = document.createElement('canvas')
  frame.append(artboard)
  stage.append(frame)

  expect(canvasWritesTouchArtboard({ stage, frame }, new Set([artboard, unrelated]))).toBe(true)
})

it('recognises a transparent-draft crosshair beside the artboard frame', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const crosshairLayer = document.createElement('div')
  crosshairLayer.className = 'paint-crosshair-layer'
  const crosshair = document.createElement('canvas')
  crosshair.className = 'paint-crosshair-tile'
  crosshairLayer.append(crosshair)
  stage.append(frame, crosshairLayer)

  expect(frame.contains(crosshair)).toBe(false)
  expect(canvasWriteTouchesArtboard({ stage, frame }, crosshair)).toBe(true)
})
