import type {
  ArchiveHistory,
  ArchiveProgressSample,
  ArchiveTileFrame,
  TileHistoryResponse,
} from '@caelestis/shared'

export interface PlaybackFrame {
  readonly bucketStart: number
  readonly hash: string | undefined
  readonly missing?: boolean
}

/** Real observations win overlapping buckets; missing frames retain an explicit coverage gap. */
export const mergeArchiveFrames = (
  live: TileHistoryResponse,
  archive: readonly ArchiveTileFrame[],
): readonly PlaybackFrame[] => {
  const resolution = live.resolution ?? 0
  const occupied = new Set<number>(live.frames.map((frame) => frame.bucketStart))
  const frames: PlaybackFrame[] = [...live.frames]
  for (const frame of archive) {
    const bucket = resolution > 0 ? Math.floor(frame.at / resolution) * resolution : frame.at
    if (occupied.has(bucket)) continue
    frames.push({
      bucketStart: frame.at,
      hash: frame.hash === null ? undefined : `archive:${frame.hash}`,
      ...(frame.hash === null ? { missing: true } : {}),
    })
  }
  return frames.sort((a, b) => a.bucketStart - b.bucketStart)
}

/** Sum only complete observations for the entire selected scope, preserving explicit gaps. */
export const combineArchiveSamples = (
  histories: readonly ArchiveHistory[],
): readonly ArchiveProgressSample[] => {
  if (histories.length === 0 || histories.some((history) => history.basis === null)) return []
  const times = new Map<number, number>()
  const byHistory = histories.map(
    (history) =>
      new Map(
        history.samples.map((sample) => {
          times.set(sample.at, sample.snapshotId)
          return [sample.at, sample] as const
        }),
      ),
  )
  return [...times]
    .sort(([a], [b]) => a - b)
    .map(([at, snapshotId]) => {
      const samples = byHistory.map((history) => history.get(at))
      const complete = samples.every(
        (sample) => sample?.correct != null && sample.mismatched !== null,
      )
      return {
        at,
        snapshotId,
        total: histories.reduce((sum, history) => sum + (history.basis?.total ?? 0), 0),
        correct: complete ? samples.reduce((sum, sample) => sum + (sample?.correct ?? 0), 0) : null,
        mismatched: complete
          ? samples.reduce((sum, sample) => sum + (sample?.mismatched ?? 0), 0)
          : null,
      }
    })
}

/** Net change belongs to the whole observed interval, not to a placement bucket or rolling window. */
export const archiveIntervals = (samples: readonly ArchiveProgressSample[]) =>
  samples.flatMap((sample, index) => {
    const before = samples[index - 1]
    if (sample.correct === null || before?.correct == null || sample.at <= before.at) return []
    return [
      {
        from: before.at,
        to: sample.at,
        startCorrect: before.correct,
        endCorrect: sample.correct,
        rate: ((sample.correct - before.correct) / (sample.at - before.at)) * 3_600,
      },
    ]
  })
