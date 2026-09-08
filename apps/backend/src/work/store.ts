import type { TemplateSurface, WorkActivity, WorkItem } from '@caelestis/shared'

/** Atomic item revisions and append-only activity, independent of the SQL dialect. */
export interface WorkStore {
  read(id: string): Promise<WorkItem | null>
  list(season: number, surface: TemplateSurface, after?: string): Promise<readonly WorkItem[]>
  revision(season: number, surface: TemplateSurface): Promise<number>
  history(id: string, before: number): Promise<readonly WorkActivity[]>
  /** Store the new revision and activity together, only if the expected revision still exists. */
  save(
    item: WorkItem,
    expectedRevision: number,
    activity: WorkActivity,
    tokenHash: string,
  ): Promise<boolean>
}
