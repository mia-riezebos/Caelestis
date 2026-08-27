import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  centre: { x: 10, y: 10 } as { x: number; y: number } | null,
  templates: [] as Array<{
    id: string
    originX: number
    originY: number
    width: number
    height: number
    visible: boolean
  }>,
}))

vi.mock('../main.js', () => ({ viewportCentre: () => harness.centre }))
vi.mock('./local-store.js', () => ({
  displayTemplates: () => harness.templates,
  isTemplateVisible: (template: { visible: boolean }) => template.visible,
}))

const template = (id: string, originX: number, originY: number, width: number, height: number) => ({
  id,
  originX,
  originY,
  width,
  height,
  visible: true,
})

beforeEach(() => {
  harness.centre = { x: 10, y: 10 }
  harness.templates = []
})

describe('template focus at the viewport centre', () => {
  it('prefers a large template containing the viewport centre over a nearer template centre', async () => {
    harness.templates = [
      template('large-containing', 0, 0, 1_000, 1_000),
      template('small-nearby', 20, 5, 10, 10),
    ]
    const { templateAtCentre } = await import('./nearest.js')

    expect(templateAtCentre()?.id).toBe('large-containing')
  })

  it('chooses the topmost template when multiple visible templates contain the centre', async () => {
    harness.templates = [template('underneath', 0, 0, 20, 20), template('on-top', 5, 5, 20, 20)]
    const { templateAtCentre } = await import('./nearest.js')

    expect(templateAtCentre()?.id).toBe('on-top')
  })

  it('falls back to nearest-centre distance when the viewport centre is in empty space', async () => {
    harness.templates = [template('farther', 100, 100, 10, 10), template('nearer', 20, 20, 10, 10)]
    const { templateAtCentre } = await import('./nearest.js')

    expect(templateAtCentre()?.id).toBe('nearer')
  })
})
