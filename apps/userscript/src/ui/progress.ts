import { WPLACE_PALETTE } from '@caelestis/shared'
import type { TemplateColourProgress, TemplateProgress } from '../templates/mismatch.js'

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

export const completionPercent = (progress: TemplateProgress): number =>
  Math.round(completionRatio(progress) * 100)

/** Add descendant progress without turning unknown pixels into unpainted pixels. */
export const sumProgress = (entries: readonly TemplateProgress[]): TemplateProgress | undefined => {
  if (entries.length === 0) return undefined
  return entries.reduce<TemplateProgress>(
    (total, entry) => ({
      completed: total.completed + entry.completed,
      mismatched: total.mismatched + entry.mismatched,
      unpainted: total.unpainted + entry.unpainted,
      known: total.known + entry.known,
      total: total.total + entry.total,
    }),
    { completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 0 },
  )
}

export const sumColourProgress = (
  groups: ReadonlyArray<readonly TemplateColourProgress[]>,
): readonly TemplateColourProgress[] | undefined => {
  if (groups.length === 0) return undefined
  const totals = new Map<number, TemplateColourProgress>()
  for (const group of groups) {
    for (const entry of group) {
      const held = totals.get(entry.index)
      totals.set(entry.index, {
        index: entry.index,
        completed: (held?.completed ?? 0) + entry.completed,
        mismatched: (held?.mismatched ?? 0) + entry.mismatched,
        unpainted: (held?.unpainted ?? 0) + entry.unpainted,
        known: (held?.known ?? 0) + entry.known,
        total: (held?.total ?? 0) + entry.total,
      })
    }
  }
  return [...totals.values()].sort((a, b) => a.index - b.index)
}

/** Prefer a complete local classification; otherwise retain the server's whole-template baseline. */
export const freshestProgress = (
  server: TemplateProgress,
  local: TemplateProgress,
): TemplateProgress =>
  local.total === server.total && local.known === local.total ? local : server

/** Replace a server colour as soon as this browser has classified every pixel of that colour. */
export const freshestColourProgress = (
  server: readonly TemplateColourProgress[],
  local: readonly TemplateColourProgress[],
): readonly TemplateColourProgress[] => {
  const localByIndex = new Map(local.map((entry) => [entry.index, entry]))
  return server.map((entry) => {
    const current = localByIndex.get(entry.index)
    return current !== undefined && current.total === entry.total && current.known === current.total
      ? current
      : entry
  })
}

const number = (value: number): string => Math.max(0, value).toLocaleString()

export const progressLabel = (progress: TemplateProgress): string => {
  const classified = `${number(progress.completed)} completed, ${number(progress.mismatched)} mismatched, ${number(progress.unpainted)} unpainted`
  const prefix = `${completionPercent(progress)}% complete. `
  if (progress.total <= progress.known) return `${prefix}${classified}.`
  return `${prefix}${classified}; ${number(progress.known)} of ${number(progress.total)} pixels scanned.`
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
  const meter = document.createElement('span')
  meter.className = 'caelestis-progress-meter'
  const percent = document.createElement('span')
  percent.className = 'caelestis-progress-percent'
  percent.textContent = `${completionPercent(progress)}%`
  meter.append(bar, percent)
  root.appendChild(meter)

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

/** One compact meter row per colour actually present in the template or aggregate. */
export const colourProgressDetails = (entries: readonly TemplateColourProgress[]): HTMLElement => {
  const root = document.createElement('span')
  root.className = 'caelestis-progress-colours'
  for (const entry of entries) {
    const colour = WPLACE_PALETTE[entry.index]
    if (colour === undefined) continue
    const row = document.createElement('span')
    row.className = 'caelestis-progress-colour-row'
    row.setAttribute('aria-label', `${colour.name}. ${progressLabel(entry)}`)

    const swatch = document.createElement('span')
    swatch.className = 'caelestis-progress-colour-swatch'
    swatch.style.backgroundColor = colour.hex

    const name = document.createElement('span')
    name.className = 'caelestis-progress-colour-name'
    name.textContent = colour.name
    name.title = colour.name

    const meter = progressIndicator(entry, 'inline')
    meter.style.setProperty('--caelestis-progress-completed', colour.hex)
    meter.removeAttribute('role')
    meter.removeAttribute('aria-label')
    meter.removeAttribute('title')
    row.append(swatch, name, meter)
    root.appendChild(row)
  }
  return root
}
