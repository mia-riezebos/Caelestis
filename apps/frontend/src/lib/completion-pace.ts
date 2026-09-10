import {
  type ArchiveProgressSample,
  type HistoryResponse,
  type ProgressSample,
  seconds,
} from '@caelestis/shared'
import { archiveIntervals, isDailyArchiveInterval } from './archive-history'
import { averagePace, type PaceAverage } from './components/charts/progress-pace'

/** Average observed net archive gains and reported correct pixels over covered time, without overlap. */
export const completionPace = (
  history: HistoryResponse | undefined,
  archives: readonly ArchiveProgressSample[],
  progress: readonly ProgressSample[],
  to: number,
  windowSeconds: number,
): Pick<PaceAverage, 'correct' | 'hours'> | null => {
  const firstProgress = progress[0]
  const imported = archiveIntervals([
    ...archives.filter((sample) => sample.at < (firstProgress?.at ?? Infinity)),
    ...(firstProgress ? [{ ...firstProgress, snapshotId: -1 }] : []),
  ])
  if (imported.length === 0) return history ? averagePace(history, to, windowSeconds) : null

  const resolution = history?.resolution
  const until = resolution === undefined ? to : Math.floor(to / resolution) * resolution
  const from = until - windowSeconds
  // Before the first report, absent telemetry buckets do not establish zero paint activity.
  const reportStart = Math.max(
    history?.coverageStart ?? Infinity,
    Math.min(...(history?.buckets ?? []).map((bucket) => bucket.bucketStart)),
  )
  const reported =
    history && Number.isFinite(reportStart)
      ? averagePace({ ...history, coverageStart: seconds(reportStart) }, to, windowSeconds)
      : null
  let hours = reported?.hours ?? 0
  let correct = (reported?.correct ?? 0) * hours
  for (const interval of imported) {
    // Keep the chart's precedence: an interval crossing into reported history is not imported.
    if (interval.to > reportStart || interval.to > until) continue
    if (interval.to - interval.from > windowSeconds && !isDailyArchiveInterval(interval)) continue
    const duration = interval.to - Math.max(interval.from, from)
    if (duration <= 0) continue
    hours += duration / 3_600
    correct += (interval.rate * duration) / 3_600
  }
  return hours > 0 ? { correct: correct / hours, hours } : null
}
