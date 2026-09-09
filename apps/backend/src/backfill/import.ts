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
      end: cutoff(template, this.now()),
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
    await this.storage.put<StoredJob>('job', {
      summary,
      snapshots,
      tiles,
      correct: 0,
      mismatched: 0,
      incomplete: false,
    })
    await this.storage.setAlarm(this.now() + 100)
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
    return { source: 'eralyon', basis, samples, frames }
  }

  /** Persist the observation before advancing, making retried alarm deliveries idempotent. */
  async step(): Promise<void> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return
    const { summary, tiles, snapshots } = held
    const template = await this.sql.readTemplate(summary.basis.templateId)
    if (template === null) {
      await this.cancel()
      return
    }
    const snapshot = snapshots[Math.floor(summary.completed / tiles.length)]
    const tile = tiles[summary.completed % tiles.length]
    if (snapshot === undefined || tile === undefined) return
    if (snapshot.at > cutoff(template, this.now())) {
      await this.cancel()
      return
    }
    // Install the next wakeup before upstream work. A crash cannot strand the durable job.
    await this.storage.setAlarm(this.now() + 60_000)
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
            if (target === null || target.width !== TILE_SIZE || target.height !== TILE_SIZE)
              throw new Error('Template chunk is unavailable or invalid.')
            for (let i = 0; i < target.indices.length; i++) {
              const colour = target.indices[i]
              if (colour === TRANSPARENT_INDEX) continue
              if (colour === pixels[i]) correct++
              else if (pixels[i] !== TRANSPARENT_INDEX) mismatched++
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
