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
  refreshProgressIndicators,
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

  it('refreshes a live meter without replacing surrounding controls', () => {
    let current = progress
    const root = document.createElement('div')
    const control = document.createElement('button')
    const meter = progressIndicator(current, 'expanded', () => current)
    root.append(control, meter)

    current = { completed: 75, mismatched: 5, unpainted: 20, known: 100, total: 100 }
    refreshProgressIndicators(root)

    expect(root.querySelector('button')).toBe(control)
    expect(root.querySelector('.caelestis-progress')).toBe(meter)
    expect(meter.querySelector('.caelestis-progress-percent')?.textContent).toBe('75%')
    expect(meter.getAttribute('aria-label')).toBe(progressLabel(current))
    expect(meter.textContent).not.toContain('scanned')
  })

  it('accumulates descendants while keeping unknown pixels separate', () => {
    expect(
      sumProgress([progress, { completed: 10, mismatched: 5, unpainted: 5, known: 20, total: 50 }]),
    ).toEqual({ completed: 50, mismatched: 15, unpainted: 35, known: 100, total: 150 })
  })

  it('keeps the server baseline authoritative while local scans load', () => {
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
        completed: 8,
        mismatched: 2,
        unpainted: 90,
        known: 100,
        total: 100,
      }),
    ).toBe(server)
  })

  it('keeps server colour counts authoritative while local colours load', () => {
    const server = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 1, known: 4, total: 4 },
      { index: 1, completed: 1, mismatched: 1, unpainted: 0, known: 2, total: 4 },
    ]
    expect(
      freshestColourProgress(server, [
        { index: 0, completed: 4, mismatched: 0, unpainted: 0, known: 4, total: 4 },
        { index: 1, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 4 },
      ]),
    ).toBe(server)
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
