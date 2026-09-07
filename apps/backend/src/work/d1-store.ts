import {
  MAX_WORK_ITEMS,
  type TemplateSurface,
  type WorkActivity,
  type WorkItem,
} from '@caelestis/shared'
import type { WorkStore } from './store.js'

/** D1 batches make the compare-and-swap and its activity entry one transaction. */
export class D1WorkStore implements WorkStore {
  constructor(private readonly database: D1Database) {}

  async read(id: string): Promise<WorkItem | null> {
    const row = await this.database
      .prepare('SELECT data FROM work_items WHERE id = ?')
      .bind(id)
      .first<{ data: string }>()
    return row === null ? null : (JSON.parse(row.data) as WorkItem)
  }

  async list(season: number, surface: TemplateSurface): Promise<readonly WorkItem[]> {
    const rows = await this.database
      .prepare(
        'SELECT data FROM work_items WHERE season = ? AND surface_kind = ? AND alliance_id IS ? ORDER BY id',
      )
      .bind(season, surface.kind, surface.allianceId)
      .all<{ data: string }>()
    return rows.results.map((row) => JSON.parse(row.data) as WorkItem)
  }

  async history(id: string, before: number): Promise<readonly WorkActivity[]> {
    const rows = await this.database
      .prepare(
        'SELECT data FROM work_activity WHERE item_id = ? AND revision < ? ORDER BY revision DESC LIMIT 50',
      )
      .bind(id, before)
      .all<{ data: string }>()
    return rows.results.map((row) => JSON.parse(row.data) as WorkActivity)
  }

  async save(
    item: WorkItem,
    expectedRevision: number,
    activity: WorkActivity,
    tokenHash: string,
  ): Promise<boolean> {
    const data = JSON.stringify(item)
    const write =
      expectedRevision === 0
        ? this.database
            .prepare(`INSERT INTO work_items (id, season, surface_kind, alliance_id, revision, mutation_id, data)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM work_items WHERE season = ? AND surface_kind = ? AND alliance_id IS ?) < ?
          ON CONFLICT(id) DO NOTHING`)
            .bind(
              item.id,
              item.season,
              item.surface.kind,
              item.surface.allianceId,
              item.revision,
              activity.id,
              data,
              item.season,
              item.surface.kind,
              item.surface.allianceId,
              MAX_WORK_ITEMS,
            )
        : this.database
            .prepare(
              'UPDATE work_items SET revision = ?, mutation_id = ?, data = ? WHERE id = ? AND revision = ?',
            )
            .bind(item.revision, activity.id, data, item.id, expectedRevision)
    const audit = this.database
      .prepare(`INSERT INTO work_activity (id, item_id, revision, token_hash, data)
      SELECT ?, id, revision, ?, ? FROM work_items WHERE id = ? AND mutation_id = ?
      ON CONFLICT(id) DO NOTHING`)
      .bind(activity.id, tokenHash, JSON.stringify(activity), item.id, activity.id)
    const results = await this.database.batch([write, audit])
    return results[0]?.meta.changes === 1
  }
}
