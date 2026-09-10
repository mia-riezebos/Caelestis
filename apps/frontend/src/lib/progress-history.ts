import type { ArchiveProgressSample, ProgressSample } from '@caelestis/shared'

export interface ObservedProgressSample extends ProgressSample {
  readonly archive: boolean
}

/** Combine scopes at fixed observation times; a scope without coverage stays unknown. */
export const combineProgressSamples = (
  histories: readonly (readonly ProgressSample[])[],
): readonly ProgressSample[] => {
  const changes = new Map<number, Map<number, ProgressSample>>()
  for (const [scope, samples] of histories.entries()) {
    for (const sample of samples) {
      const entries = changes.get(sample.at) ?? new Map<number, ProgressSample>()
      entries.set(scope, sample)
      changes.set(sample.at, entries)
    }
  }
  const latest = new Map<number, ProgressSample>()
  return [...changes]
    .sort(([a], [b]) => a - b)
    .map(([at, entries]) => {
      for (const [scope, sample] of entries) latest.set(scope, sample)
      const held = [...latest.values()]
      const complete =
        held.length > 0 &&
        held.length === histories.length &&
        held.every((sample) => sample?.correct != null && sample.mismatched !== null)
      return {
        at,
        correct: complete ? held.reduce((sum, sample) => sum + (sample?.correct ?? 0), 0) : null,
        mismatched: complete
          ? held.reduce((sum, sample) => sum + (sample?.mismatched ?? 0), 0)
          : null,
        total: held.reduce((sum, sample) => sum + (sample?.total ?? 0), 0),
      }
    })
}

/** Keep measured values at their original times. Today's observation can only add today's point. */
export const mergeObservedProgress = (
  archive: readonly ArchiveProgressSample[],
  observed: readonly ProgressSample[],
  current?: Omit<ProgressSample, 'total'>,
): readonly ObservedProgressSample[] => {
  const covered = (samples: readonly ProgressSample[], at: number): boolean => {
    const before = samples.findLast((sample) => sample.at <= at)
    const after = samples.find((sample) => sample.at >= at)
    return (
      before?.correct != null &&
      before.mismatched != null &&
      after?.correct != null &&
      after.mismatched != null
    )
  }
  const byTime = new Map<number, ObservedProgressSample>(
    archive
      .filter((sample) => sample.correct !== null || !covered(observed, sample.at))
      .map((sample) => [sample.at, { ...sample, archive: true }]),
  )
  for (const sample of observed) {
    // Missing native recounts cannot erase an available archive observation.
    if (sample.correct === null && covered(archive, sample.at)) continue
    byTime.set(sample.at, { ...sample, archive: false })
  }
  if (current !== undefined)
    byTime.set(current.at, {
      ...current,
      total: observed.at(-1)?.total ?? archive.at(-1)?.total ?? 0,
      archive: false,
    })
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}
