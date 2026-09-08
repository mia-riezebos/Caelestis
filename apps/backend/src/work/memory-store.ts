import {
  MAX_WORK_ITEMS,
  sameTemplateSurface,
  type TemplateSurface,
  type WorkActivity,
  type WorkItem,
} from '@caelestis/shared'
import type { WorkStore } from './store.js'

export class MemoryWorkStore implements WorkStore {
  private readonly items = new Map<string, WorkItem>()
  private readonly events = new Map<string, WorkActivity[]>()

  async read(id: string): Promise<WorkItem | null> {
    return structuredClone(this.items.get(id) ?? null)
  }

  async list(season: number, surface: TemplateSurface, after = ''): Promise<readonly WorkItem[]> {
    return structuredClone(
      [...this.items.values()]
        .filter(
          (item) =>
            item.id > after && item.season === season && sameTemplateSurface(item.surface, surface),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, MAX_WORK_ITEMS),
    )
  }

  async revision(season: number, surface: TemplateSurface): Promise<number> {
    return [...this.items.values()]
      .filter((item) => item.season === season && sameTemplateSurface(item.surface, surface))
      .reduce((sum, item) => sum + item.revision, 0)
  }

  async history(id: string, before: number): Promise<readonly WorkActivity[]> {
    return structuredClone(
      (this.events.get(id) ?? [])
        .filter((event) => event.item.revision < before)
        .slice(-50)
        .reverse(),
    )
  }

  async save(
    item: WorkItem,
    expectedRevision: number,
    activity: WorkActivity,
    _tokenHash: string,
  ): Promise<boolean> {
    const held = this.items.get(item.id)
    if ((held?.revision ?? 0) !== expectedRevision) return false
    this.items.set(item.id, structuredClone(item))
    this.events.set(item.id, [...(this.events.get(item.id) ?? []), structuredClone(activity)])
    return true
  }
}
