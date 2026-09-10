import {
  type ArchiveHistory,
  type ArchiveProgressSample,
  type ArchiveSnapshot,
  type ArchiveTileFrame,
  type BackfillBasis,
  type BackfillJob,
  type BackfillPreview,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  planTimelapseTiles,
  sha256Hex,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  uuidV7,
} from '@caelestis/shared'
import type { BlobStore, SqlStore, TemplateRecord } from '../ports/index.js'

/** Durable storage needed by the import, independent of the Cloudflare adapter. */
export interface BackfillStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
  setAlarm(at: number): Promise<void>
}

export interface ArchiveSource {
  snapshots(): Promise<readonly ArchiveSnapshot[]>
  tile(snapshotId: number, tile: TileCoord): Promise<Uint8Array | null>
}

interface StoredJob {
  readonly summary: BackfillJob
  readonly snapshots: readonly ArchiveSnapshot[]
  readonly tiles: readonly TileCoord[]
  readonly correct: number
  readonly mismatched: number
  readonly incomplete: boolean
}

interface Observation extends ArchiveTileFrame {
  readonly correct: number
  readonly mismatched: number
}

/** A user-correctable import refusal, distinct from an upstream or storage failure. */
export class BackfillError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

const suffix = (id: number): string => String(id).padStart(10, '0')
const tilePrefix = (version: string, tile: TileCoord): string =>
  `tile:${version}:${tile.x}/${tile.y}:`
const cutoff = (template: TemplateRecord, now: number): number =>
  Math.floor(
    Math.min(
      now,
      template.finishedAt ?? now,
      template.timelapseFrozen ? (template.timelapseFrozenAt ?? template.updatedAt) : now,
    ) / 1_000,
  )

/** Resumable import with one tile per alarm. Callers serialize start, cancel and step. */
export class TemplateBackfill {
  constructor(
    private readonly storage: BackfillStorage,
    private readonly sql: SqlStore,
    private readonly blobs: BlobStore,
    private readonly archive: ArchiveSource,
    private readonly now: () => number = Date.now,
  ) {}

  private async basis(templateId: string): Promise<{ basis: BackfillBasis; end: number }> {
    const template = await this.sql.readTemplate(templateId)
    if (template === null) throw new BackfillError('Template no longer exists.', 404)
    if (template.surface.kind !== 'world' || template.season !== 0)
      throw new BackfillError('Eralyon backfill supports season 0 world templates only.')
    const version =
      template.currentVersionId === null
        ? null
        : await this.sql.readTemplateVersion(template.currentVersionId)
    if (version === null) throw new BackfillError('Template artwork is unavailable.', 409)
    const firstLive = await this.sql.readFirstTemplateObservation(version.versionId)
    return {
      basis: {
        templateId,
        versionId: version.versionId,
        name: template.name,
        season: template.season,
        bbox: version.bbox,
        total: version.totalPixels,
        chunks: version.chunks,
      },
      end: Math.min(cutoff(template, this.now()), firstLive === null ? Infinity : firstLive - 1),
    }
  }

  async job(): Promise<BackfillJob | null> {
    return (await this.storage.get<StoredJob>('job'))?.summary ?? null
  }

  async preview(templateId: string): Promise<BackfillPreview> {
    const { basis, end } = await this.basis(templateId)
    const snapshots = (await this.archive.snapshots()).filter((snapshot) => snapshot.at <= end)
    return {
      basis,
      snapshots,
      end,
      tileCount: planTimelapseTiles([basis.bbox]).length,
      job: await this.job(),
    }
  }

  async start(templateId: string, versionId: string, fromSnapshot: number): Promise<BackfillJob> {
    const held = await this.job()
    if (held?.status === 'running') {
      await this.storage.setAlarm(this.now() + 100)
      return held
    }
    const preview = await this.preview(templateId)
    if (preview.basis.versionId !== versionId)
      throw new BackfillError('Template artwork changed. Reopen the backfill form.', 409)
    if (!preview.snapshots.some((snapshot) => snapshot.id === fromSnapshot))
      throw new BackfillError('Choose an available snapshot.')
    const snapshots = preview.snapshots.filter((snapshot) => snapshot.id >= fromSnapshot)
    const tiles = planTimelapseTiles([preview.basis.bbox])
    const summary: BackfillJob = {
      id: uuidV7(),
      basis: preview.basis,
      from: snapshots[0]?.at ?? 0,
      to: snapshots.at(-1)?.at ?? 0,
      status: 'running',
      completed: 0,
      total: snapshots.length * tiles.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      error: null,
    }
    await this.storage.put(`basis:${versionId}`, preview.basis)
    // A failed schedule must not leave the form observing an unstartable running job.
    await this.storage.setAlarm(this.now() + 100)
    await this.storage.put<StoredJob>('job', {
      summary,
      snapshots,
      tiles,
      correct: 0,
      mismatched: 0,
      incomplete: false,
    })
    return summary
  }

  async cancel(): Promise<BackfillJob | null> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return held?.summary ?? null
    const summary: BackfillJob = { ...held.summary, status: 'cancelled' }
    await this.storage.put('job', { ...held, summary })
    return summary
  }

  async history(versionId: string, tile?: TileCoord): Promise<ArchiveHistory> {
    const basis = (await this.storage.get<BackfillBasis>(`basis:${versionId}`)) ?? null
    const firstLive = await this.sql.readFirstTemplateObservation(versionId)
    const samples =
      tile === undefined
        ? [
            ...(
              await this.storage.list<ArchiveProgressSample>({ prefix: `sample:${versionId}:` })
            ).values(),
          ]
        : []
    const frames =
      tile === undefined
        ? []
        : [
            ...(
              await this.storage.list<Observation>({ prefix: tilePrefix(versionId, tile) })
            ).values(),
          ].map(({ at, snapshotId, hash }) => ({ at, snapshotId, hash }))
    const beforeLive = ({ at }: { at: number }) => firstLive === null || at < firstLive
    return {
      source: 'eralyon',
      basis,
      samples: samples.filter(beforeLive),
      frames: frames.filter(beforeLive),
    }
  }

  /** Persist the observation before advancing, making retried alarm deliveries idempotent. */
  async step(): Promise<void> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return
    const { summary, tiles, snapshots } = held
    // Rearm before external storage reads too, so a transient D1 failure cannot strand the job.
    await this.storage.setAlarm(this.now() + 60_000)
    const template = await this.sql.readTemplate(summary.basis.templateId)
    if (template === null) {
      await this.cancel()
      return
    }
    const snapshot = snapshots[Math.floor(summary.completed / tiles.length)]
    const tile = tiles[summary.completed % tiles.length]
    if (snapshot === undefined || tile === undefined) return
    const firstLive = await this.sql.readFirstTemplateObservation(summary.basis.versionId)
    if (firstLive !== null && snapshot.at >= firstLive) {
      await this.storage.put<StoredJob>('job', {
        ...held,
        summary: {
          ...summary,
          to: snapshots.findLast((entry) => entry.at < firstLive)?.at ?? summary.from,
          total: summary.completed,
          status: summary.failed > 0 ? 'failed' : 'completed',
        },
      })
      return
    }
    if (snapshot.at > cutoff(template, this.now())) {
      await this.cancel()
      return
    }
    const chunk = summary.basis.chunks.find(
      (entry) => entry.tileX === tile.x && entry.tileY === tile.y,
    )
    const key = `${tilePrefix(summary.basis.versionId, tile)}${suffix(snapshot.id)}`
    let observation = await this.storage.get<Observation>(key)
    let imported = 0,
      skipped = 0,
      failed = 0
    let error = summary.error
    try {
      if (observation === undefined) {
        const pixels = await this.archive.tile(snapshot.id, tile)
        let correct = 0,
          mismatched = 0
        let hash: string | null = null
        if (pixels !== null) {
          if (chunk !== undefined) {
            const bytes = await this.blobs.get('chunks', chunk.hash)
            const target = bytes === null ? null : await decodeWplaceIndexedPng(bytes)
            const { bbox } = summary.basis
            const wraps = bbox.minX > bbox.maxX
            const tileLeft = tile.x * TILE_SIZE
            const highSpan = tileLeft + TILE_SIZE > bbox.minX
            const left = wraps && !highSpan ? 0 : Math.max(0, bbox.minX - tileLeft)
            const right = wraps && highSpan ? TILE_SIZE : Math.min(TILE_SIZE, bbox.maxX - tileLeft)
            const top = Math.max(0, bbox.minY - tile.y * TILE_SIZE)
            const bottom = Math.min(TILE_SIZE, bbox.maxY - tile.y * TILE_SIZE)
            if (target === null || target.width !== right - left || target.height !== bottom - top)
              throw new Error('Template chunk is unavailable or invalid.')
            for (let i = 0; i < target.indices.length; i++) {
              const colour = target.indices[i]
              if (colour === TRANSPARENT_INDEX) continue
              const actual =
                pixels[(top + Math.floor(i / target.width)) * TILE_SIZE + left + (i % target.width)]
              if (colour === actual) correct++
              else if (actual !== TRANSPARENT_INDEX) mismatched++
            }
          }
          const png = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, pixels)
          hash = await sha256Hex(png)
          await this.blobs.put('archives', hash, png)
        }
        observation = { at: snapshot.at, snapshotId: snapshot.id, hash, correct, mismatched }
        await this.storage.put(key, observation)
        if (hash === null) skipped++
        else imported++
      } else skipped++
    } catch (cause) {
      failed++
      error = cause instanceof Error ? cause.message : String(cause)
    }
    let correct = held.correct + (observation?.correct ?? 0)
    let mismatched = held.mismatched + (observation?.mismatched ?? 0)
    let incomplete = held.incomplete || (chunk !== undefined && observation?.hash == null)
    const completed = summary.completed + 1
    if (completed % tiles.length === 0) {
      await this.storage.put<ArchiveProgressSample>(
        `sample:${summary.basis.versionId}:${suffix(snapshot.id)}`,
        {
          at: snapshot.at,
          snapshotId: snapshot.id,
          correct: incomplete ? null : correct,
          mismatched: incomplete ? null : mismatched,
          total: summary.basis.total,
        },
      )
      correct = 0
      mismatched = 0
      incomplete = false
    }
    const next: BackfillJob = {
      ...summary,
      completed,
      imported: summary.imported + imported,
      skipped: summary.skipped + skipped,
      failed: summary.failed + failed,
      error,
      status:
        completed === summary.total
          ? summary.failed + failed > 0
            ? 'failed'
            : 'completed'
          : 'running',
    }
    await this.storage.put<StoredJob>('job', {
      ...held,
      summary: next,
      correct,
      mismatched,
      incomplete,
    })
    if (next.status === 'running') await this.storage.setAlarm(this.now() + 100)
  }
}
