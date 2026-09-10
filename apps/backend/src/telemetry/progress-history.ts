import { type ProgressHistoryResponse, type ProgressSample, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import type { MeasuredTileFrame, TemplateVersionRecord } from '../ports/sql-store.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { SqlStoreReadError } from '../runtime/errors.js'
import { type HistoryRange, selectTileHistoryResolution } from './queries.js'

/** Replay saved tile classifications; placement totals and current status never enter this read. */
export const readProgressHistory = (
  version: TemplateVersionRecord,
  range: HistoryRange,
): Effect.Effect<ProgressHistoryResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const resolution = selectTileHistoryResolution(range)
    if (version.surface.kind !== 'world')
      return { versionId: version.versionId, resolution, samples: [] }
    const changes = new Map<number, Map<string, MeasuredTileFrame>>()
    const frames = yield* Effect.tryPromise({
      try: () =>
        sql.readTemplateProgressFrames(
          version.versionId,
          range.fromSeconds,
          range.toSeconds,
          resolution,
        ),
      catch: (cause) => new SqlStoreReadError({ operation: 'readTemplateProgressFrames', cause }),
    })
    for (const frame of frames) {
      // Folded frames represent an observation somewhere within the bucket. Stamp its end so
      // pixels from later in the interval are never attributed to its start or a moving "now".
      const at = frame.bucketStart + resolution
      if (at >= range.toSeconds) continue
      const entries = changes.get(at) ?? new Map<string, MeasuredTileFrame>()
      entries.set(`${frame.tileX}/${frame.tileY}`, frame)
      changes.set(at, entries)
    }
    const held = new Map<string, MeasuredTileFrame>()
    const samples: ProgressSample[] = []
    for (const [at, entries] of [...changes].sort(([a], [b]) => a - b)) {
      for (const [key, value] of entries) held.set(key, value)
      const values = [...held.values()]
      const complete =
        held.size === version.chunks.length &&
        values.every((value) => value.correct !== null && value.wrong !== null)
      const correct = values.reduce((sum, value) => sum + (value?.correct ?? 0), 0)
      const mismatched = values.reduce((sum, value) => sum + (value?.wrong ?? 0), 0)
      samples.push({
        at: seconds(at),
        correct: complete ? correct : null,
        mismatched: complete ? mismatched : null,
        total: version.totalPixels,
      })
    }
    return { versionId: version.versionId, resolution, samples }
  })
