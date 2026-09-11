import {
  MAX_PRESENCE_REGIONS,
  type RegionClaim,
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { workRegions } from '../db/schema.js'
import type { RegionStore } from './region-store.js'

const fromRow = (row: typeof workRegions.$inferSelect): RegionClaim => {
  const surface = templateSurface(row.surfaceKind, row.allianceId)
  if (surface === null) throw new Error('Invalid stored region surface')
  return {
    id: row.id,
    season: row.season,
    surface,
    templateId: row.templateId,
    claimant: { wplaceUserId: row.claimantUserId, displayName: row.claimantName },
    rect: { x: row.x, y: row.y, w: row.w, h: row.h },
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

  async createRegion(region: RegionClaim): Promise<boolean> {
    const { surface, rect, claimant } = region
    const result = await this.client
      .prepare(`INSERT INTO work_regions
      (id, season, surface_kind, alliance_id, template_id, claimant_user_id, claimant_name, x, y, w, h, label, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM work_regions WHERE season = ? AND surface_kind = ? AND alliance_id IS ?) < ?
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        region.id,
        region.season,
        surface.kind,
        surface.allianceId,
        region.templateId,
        claimant.wplaceUserId,
        claimant.displayName,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        region.label,
        region.createdAt,
        region.season,
        surface.kind,
        surface.allianceId,
        MAX_PRESENCE_REGIONS,
      )
      .run()
    return result.meta.changes === 1
  }

  async deleteRegion(id: string): Promise<void> {
    await this.db.delete(workRegions).where(eq(workRegions.id, id))
  }
}
