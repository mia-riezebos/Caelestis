import type {
  TemplateColourProgress,
  TemplateColourProgressDelta,
  TemplateProgress,
} from '../templates/mismatch.js'

export const emptyProgress = (total: number): TemplateProgress => ({
  completed: 0,
  mismatched: 0,
  unpainted: 0,
  known: 0,
  total: Math.max(0, total),
})

export const completionRatio = (progress: TemplateProgress): number =>
  progress.total <= 0 ? 0 : Math.min(1, Math.max(0, progress.completed / progress.total))

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
  return [...totals.values()].sort((left, right) => left.index - right.index)
}

export const freshestProgress = (
  server: TemplateProgress,
  _local: TemplateProgress,
): TemplateProgress => server

export const freshestColourProgress = (
  server: readonly TemplateColourProgress[],
  _local: readonly TemplateColourProgress[],
): readonly TemplateColourProgress[] => server

/** Apply one exact category transfer while preserving a complete colour-progress invariant. */
export const applyColourProgressDelta = (
  baseline: TemplateColourProgress,
  delta: TemplateColourProgressDelta,
): TemplateColourProgress => {
  const completed = Math.max(0, Math.min(baseline.known, baseline.completed + delta.completed))
  const remaining = baseline.known - completed
  const mismatched = Math.max(0, Math.min(remaining, baseline.mismatched + delta.mismatched))
  return {
    ...baseline,
    completed,
    mismatched,
    unpainted: remaining - mismatched,
  }
}
