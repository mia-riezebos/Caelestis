import { DurableObject } from 'cloudflare:workers'
import type { TileCoord } from '@caelestis/shared'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { EralyonArchive } from './backfill/eralyon.js'
import { TemplateBackfill } from './backfill/import.js'
import { backfillReply } from './backfill/port.js'
import { instrumentD1 } from './metrics/request-metrics.js'

/** One template's serialized import commands and durable alarm-driven history. */
export class TemplateBackfillObject extends DurableObject<Env> {
  private readonly importer: TemplateBackfill
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.importer = new TemplateBackfill(
      ctx.storage,
      new D1SqlStore(instrumentD1(env.DB)),
      new R2BlobStore(env.BLOBS),
      new EralyonArchive(),
    )
  }
  async preview(templateId: string) {
    return backfillReply(() => this.importer.preview(templateId))
  }
  async job() {
    return backfillReply(() => this.importer.job())
  }
  async history(versionId: string, tile?: TileCoord) {
    return backfillReply(() => this.importer.history(versionId, tile))
  }
  async start(templateId: string, versionId: string, snapshotId: number) {
    return this.ctx.blockConcurrencyWhile(() =>
      backfillReply(() => this.importer.start(templateId, versionId, snapshotId)),
    )
  }
  async cancel() {
    return this.ctx.blockConcurrencyWhile(() => backfillReply(() => this.importer.cancel()))
  }
  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.importer.step())
  }
}
