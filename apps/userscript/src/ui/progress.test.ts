// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  colourProgressDetails,
  completionPercent,
  completionRatio,
  freshestColourProgress,
  freshestProgress,
  progressIndicator,
  progressLabel,
  sumProgress,
} from './progress.js'

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

  it('accumulates descendants while keeping unknown pixels separate', () => {
    expect(
      sumProgress([progress, { completed: 10, mismatched: 5, unpainted: 5, known: 20, total: 50 }]),
    ).toEqual({ completed: 50, mismatched: 15, unpainted: 35, known: 100, total: 150 })
  })

  it('uses complete local truth without replacing unknown server coverage', () => {
    const server = { completed: 40, mismatched: 10, unpainted: 30, known: 80, total: 100 }
    expect(
      freshestProgress(server, {
        completed: 20,
        mismatched: 0,
        unpainted: 0,
        known: 20,
        total: 100,
      }),
    ).toBe(server)
    expect(
      freshestProgress(server, {
        completed: 90,
        mismatched: 5,
        unpainted: 5,
        known: 100,
        total: 100,
      }),
    ).toEqual({ completed: 90, mismatched: 5, unpainted: 5, known: 100, total: 100 })
  })

  it('replaces each fully known local colour independently', () => {
    expect(
      freshestColourProgress(
        [
          { index: 0, completed: 2, mismatched: 1, unpainted: 1, known: 4, total: 4 },
          { index: 1, completed: 1, mismatched: 1, unpainted: 0, known: 2, total: 4 },
        ],
        [
          { index: 0, completed: 4, mismatched: 0, unpainted: 0, known: 4, total: 4 },
          { index: 1, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 4 },
        ],
      ),
    ).toEqual([
      { index: 0, completed: 4, mismatched: 0, unpainted: 0, known: 4, total: 4 },
      { index: 1, completed: 1, mismatched: 1, unpainted: 0, known: 2, total: 4 },
    ])
  })

  it('renders one identified meter row for every template colour', () => {
    const details = colourProgressDetails([
      { index: 0, completed: 3, mismatched: 1, unpainted: 0, known: 4, total: 5 },
      { index: 4, completed: 2, mismatched: 0, unpainted: 1, known: 3, total: 3 },
    ])

    const rows = details.querySelectorAll('.caelestis-progress-colour-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-label')).toContain('Black')
    expect(rows[1]?.getAttribute('aria-label')).toContain('White')
    expect(rows[0]?.querySelector('.caelestis-progress-percent')?.textContent).toBe('60%')
    expect(
      rows[0]
        ?.querySelector<HTMLElement>('.caelestis-progress')
        ?.style.getPropertyValue('--caelestis-progress-completed'),
    ).toBe('#000000')
  })
})
