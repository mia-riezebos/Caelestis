import {
  isRegionDocument,
  isRegionShape,
  MAX_PRESENCE_REGIONS,
  type RegionClaim,
  type RegionDocument,
  regionDocumentBounds,
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { workRegions } from '../db/schema.js'
import type { RegionStore, RegionWriter } from './region-store.js'

const ownedBy = (writer: RegionWriter) =>
  writer.admin
    ? undefined
    : and(
        eq(workRegions.claimantUserId, writer.actorId),
        or(isNull(workRegions.tokenHash), eq(workRegions.tokenHash, writer.tokenHash)),
      )

const fromRow = (row: typeof workRegions.$inferSelect): RegionClaim => {
  const surface = templateSurface(row.surfaceKind, row.allianceId)
  if (surface === null) throw new Error('Invalid stored region surface')
  const rect = { x: row.x, y: row.y, w: row.w, h: row.h }
  let shape: unknown = null
  if (row.shape !== null) {
    try {
      shape = JSON.parse(row.shape)
    } catch {
      // Malformed document data falls back to the stored rectangle.
    }
  }
  return {
    id: row.id,
    season: row.season,
    surface,
    templateId: row.templateId,
    claimant: { wplaceUserId: row.claimantUserId, displayName: row.claimantName },
    document: isRegionDocument(shape)
      ? shape
      : {
          items: [
            {
              id: 'legacy',
              shape: isRegionShape(shape) ? shape : { kind: 'rectangle', ...rect },
              op: 'add',
            },
          ],
        },
    rect,
    label: row.label,
    createdAt: row.createdAt,
  }
}

/** D1 enforces the per-surface cap and ID uniqueness in the same insert statement. */
export class D1RegionStore implements RegionStore {
  private readonly db
  constructor(private readonly client: D1Database) {
    this.db = drizzle(client)
  }

  async listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]> {
    const rows = await this.db
      .select()
      .from(workRegions)
      .where(
        and(
          eq(workRegions.season, season),
          eq(workRegions.surfaceKind, surface.kind),
          surface.allianceId === null
            ? isNull(workRegions.allianceId)
            : eq(workRegions.allianceId, surface.allianceId),
          templateId === undefined ? undefined : eq(workRegions.templateId, templateId),
        ),
      )
      .orderBy(asc(workRegions.createdAt), asc(workRegions.id))
      .limit(MAX_PRESENCE_REGIONS)
    return rows.map(fromRow)
  }

  async readRegion(id: string): Promise<RegionClaim | null> {
    const [row] = await this.db.select().from(workRegions).where(eq(workRegions.id, id)).limit(1)
    return row === undefined ? null : fromRow(row)
  }

  async createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean> {
    const { surface, document, claimant } = region
    const rect = regionDocumentBounds(document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    const result = await this.client
      .prepare(`INSERT INTO work_regions
      (id, season, surface_kind, alliance_id, template_id, claimant_user_id, claimant_name, x, y, w, h, label, created_at, shape, token_hash)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM work_regions WHERE season = ? AND surface_kind = ? AND alliance_id IS ?) < ?
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        region.id,
        region.season,
        surface.kind,
        surface.allianceId,
        region.templateId ?? null,
        claimant.wplaceUserId,
        claimant.displayName,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        region.label,
        region.createdAt,
        JSON.stringify(document),
        tokenHash,
        region.season,
        surface.kind,
        surface.allianceId,
        MAX_PRESENCE_REGIONS,
      )
      .run()
    return result.meta.changes === 1
  }

  async deleteRegion(id: string, writer: RegionWriter): Promise<boolean> {
    const rows = await this.db
      .delete(workRegions)
      .where(and(eq(workRegions.id, id), ownedBy(writer)))
      .returning({ id: workRegions.id })
    return rows.length === 1
  }

  async updateRegion(
    id: string,
    document: RegionDocument,
    label: string,
    templateId: string | null,
    writer: RegionWriter,
  ): Promise<RegionClaim | null> {
    const rect = regionDocumentBounds(document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    const [row] = await this.db
      .update(workRegions)
      .set({
        shape: JSON.stringify(document),
        ...rect,
        label,
        templateId,
        tokenHash: sql`coalesce(${workRegions.tokenHash}, ${writer.tokenHash})`,
      })
      .where(and(eq(workRegions.id, id), ownedBy(writer)))
      .returning()
    return row === undefined ? null : fromRow(row)
  }
}
