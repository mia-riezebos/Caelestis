import type { TemplateProgress } from '../templates/mismatch.js'

/** A count-only answer for a template whose pixels have not reached this browser yet. */
export const emptyProgress = (total: number): TemplateProgress => ({
  completed: 0,
  mismatched: 0,
  unpainted: 0,
  known: 0,
  total: Math.max(0, total),
})

/** Completion uses the whole template as its denominator; unscanned pixels are not presumed done. */
export const completionRatio = (progress: TemplateProgress): number =>
  progress.total <= 0 ? 0 : Math.min(1, Math.max(0, progress.completed / progress.total))

const number = (value: number): string => Math.max(0, value).toLocaleString()

export const progressLabel = (progress: TemplateProgress): string => {
  const classified = `${number(progress.completed)} completed, ${number(progress.mismatched)} mismatched, ${number(progress.unpainted)} unpainted`
  if (progress.total <= progress.known) return `${classified}.`
  return `${classified}; ${number(progress.known)} of ${number(progress.total)} pixels scanned.`
}

/** One three-way meter. Remaining track is deliberately unknown, not a fourth progress segment. */
export const progressIndicator = (
  progress: TemplateProgress,
  placement: 'inline' | 'expanded',
): HTMLElement => {
  const root = document.createElement('span')
  root.className = `caelestis-progress caelestis-progress--${placement}`
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', progressLabel(progress))
  root.title = progressLabel(progress)

  const bar = document.createElement('span')
  bar.className = 'caelestis-progress-track'
  const total = Math.max(1, progress.total)
  for (const [kind, value] of [
    ['completed', progress.completed],
    ['mismatched', progress.mismatched],
    ['unpainted', progress.unpainted],
  ] as const) {
    const segment = document.createElement('span')
    segment.className = `caelestis-progress-segment caelestis-progress-${kind}`
    segment.style.width = `${Math.min(100, Math.max(0, (value / total) * 100))}%`
    bar.appendChild(segment)
  }
  root.appendChild(bar)

  if (placement === 'expanded') {
    const legend = document.createElement('span')
    legend.className = 'caelestis-progress-legend'
    for (const [kind, value] of [
      ['completed', progress.completed],
      ['mismatched', progress.mismatched],
      ['unpainted', progress.unpainted],
    ] as const) {
      const item = document.createElement('span')
      item.className = `caelestis-progress-legend-item caelestis-progress-${kind}`
      item.textContent = number(value)
      legend.appendChild(item)
    }
    if (progress.known < progress.total) {
      const coverage = document.createElement('span')
      coverage.className = 'caelestis-progress-coverage'
      coverage.textContent = `${Math.round((progress.known / Math.max(1, progress.total)) * 100)}% scanned`
      legend.appendChild(coverage)
    }
    root.appendChild(legend)
  }

  return root
}
