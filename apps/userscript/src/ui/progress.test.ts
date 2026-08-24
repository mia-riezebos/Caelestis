// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { completionPercent, completionRatio, progressIndicator, progressLabel } from './progress.js'

const progress = { completed: 40, mismatched: 10, unpainted: 30, known: 80, total: 100 }

describe('template progress', () => {
  it('uses the whole template for completion and calls out partial scan coverage', () => {
    expect(completionRatio(progress)).toBe(0.4)
    expect(completionPercent(progress)).toBe(40)
    expect(progressLabel(progress)).toBe(
      '40% complete. 40 completed, 10 mismatched, 30 unpainted; 80 of 100 pixels scanned.',
    )
  })

  it('renders completed, mismatched, and unpainted as one accessible stacked meter', () => {
    const meter = progressIndicator(progress, 'expanded')
    const segments = meter.querySelectorAll<HTMLElement>('.caelestis-progress-segment')

    expect(meter.getAttribute('role')).toBe('img')
    expect(meter.getAttribute('aria-label')).toBe(progressLabel(progress))
    expect([...segments].map((segment) => segment.style.width)).toEqual(['40%', '10%', '30%'])
    expect(meter.querySelector('.caelestis-progress-percent')?.textContent).toBe('40%')
    expect(meter.textContent).toContain('80% scanned')
  })
})
