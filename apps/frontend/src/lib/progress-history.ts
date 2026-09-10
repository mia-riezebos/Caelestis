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

/** Keep archive observations strictly before native history, including explicit native gaps. */
export const mergeObservedProgress = (
  archive: readonly ArchiveProgressSample[],
  observed: readonly ProgressSample[],
  current?: Omit<ProgressSample, 'total'>,
): readonly ObservedProgressSample[] => {
  const firstLive = Math.min(current?.at ?? Infinity, ...observed.map((sample) => sample.at))
  const byTime = new Map<number, ObservedProgressSample>(
    archive
      .filter((sample) => sample.at < firstLive)
      .map((sample) => [sample.at, { ...sample, archive: true }]),
  )
  for (const sample of observed) {
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
