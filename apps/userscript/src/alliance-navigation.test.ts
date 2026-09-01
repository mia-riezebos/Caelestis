// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { navigateAllianceArtboardTo } from './alliance-navigation.js'

it('centres an alliance target with inverse wheel steps at unchanged zoom', () => {
  class TestWheelEvent extends Event {
    static readonly DOM_DELTA_PIXEL = 0
    readonly clientX: number
    readonly clientY: number
    readonly deltaY: number

    constructor(type: string, init: WheelEventInit) {
      super(type, init)
      this.clientX = init.clientX ?? 0
      this.clientY = init.clientY ?? 0
      this.deltaY = init.deltaY ?? 0
    }
  }
  vi.stubGlobal('WheelEvent', TestWheelEvent)
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const wheel = vi.fn()
  stage.addEventListener('wheel', wheel)
  stage.getBoundingClientRect = () =>
    ({ left: 100, top: 100, width: 600, height: 500, right: 700, bottom: 600 }) as DOMRect
  frame.getBoundingClientRect = () =>
    ({ left: 200, top: 150, width: 500, height: 500, right: 700, bottom: 650 }) as DOMRect

  expect(
    navigateAllianceArtboardTo(
      {
        surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
        stage,
        frame,
        draftId: null,
        bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
      },
      { x: 100.5, y: -99.5 },
    ),
  ).toBe(true)
  expect(wheel).toHaveBeenCalledTimes(2)
  const [out, restore] = wheel.mock.calls.map(([event]) => event as WheelEvent)
  expect([out?.deltaY, restore?.deltaY]).toEqual([-100, 100])
  expect([restore?.clientX, restore?.clientY]).toEqual([400, 350])
})
