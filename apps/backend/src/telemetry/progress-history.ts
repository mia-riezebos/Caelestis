import { type ProgressHistoryResponse, type ProgressSample, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import type { TemplateVersionRecord, TileMeasurement } from '../ports/sql-store.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { SqlStoreReadError } from '../runtime/errors.js'
import { type HistoryRange, readTileHistory, selectTileHistoryResolution } from './queries.js'

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
    const changes = new Map<number, Map<string, TileMeasurement | null>>()
    for (const chunk of version.chunks) {
      const tile = { x: chunk.tileX, y: chunk.tileY }
      const key = `${tile.x}/${tile.y}`
      const history = yield* readTileHistory({ season: version.season, tile, range })
      const measurements = yield* Effect.tryPromise({
        try: () =>
          sql.readTileMeasurements(version.versionId, tile, [
            ...new Set(history.frames.map((frame) => frame.hash)),
          ]),
        catch: (cause) => new SqlStoreReadError({ operation: 'readTileMeasurements', cause }),
      })
      const byHash = new Map(measurements.map((measurement) => [measurement.hash, measurement]))
      for (const frame of history.frames) {
        // Folded frames represent an observation somewhere within the bucket. Stamp its end so
        // pixels from later in the interval are never attributed to its start or a moving "now".
        const at = frame.bucketStart + resolution
        if (at >= range.toSeconds) continue
        const entries = changes.get(at) ?? new Map<string, TileMeasurement | null>()
        entries.set(key, byHash.get(frame.hash) ?? null)
        changes.set(at, entries)
      }
    }
    const held = new Map<string, TileMeasurement | null>()
    const samples: ProgressSample[] = []
    for (const [at, entries] of [...changes].sort(([a], [b]) => a - b)) {
      for (const [key, value] of entries) held.set(key, value)
      const values = [...held.values()]
      const complete =
        held.size === version.chunks.length && values.every((value) => value !== null)
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
