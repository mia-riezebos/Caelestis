import {
  MAX_PRESENCE_REGIONS,
  type RegionClaim,
  type RegionShape,
  regionShapeBounds,
  sameTemplateSurface,
  type TemplateSurface,
} from '@caelestis/shared'
import type { RegionStore } from './region-store.js'

/** In-memory equivalent of D1's bounded region records. */
export class MemoryRegionStore implements RegionStore {
  private readonly records = new Map<string, RegionClaim>()

  async listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]> {
    return [...this.records.values()]
      .filter(
        (region) =>
          region.season === season &&
          sameTemplateSurface(region.surface, surface) &&
          (templateId === undefined || region.templateId === templateId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, MAX_PRESENCE_REGIONS)
  }
  async readRegion(id: string): Promise<RegionClaim | null> {
    return this.records.get(id) ?? null
  }
  async createRegion(region: RegionClaim): Promise<boolean> {
    const count = [...this.records.values()].filter(
      (held) => held.season === region.season && sameTemplateSurface(held.surface, region.surface),
    ).length
    if (this.records.has(region.id) || count >= MAX_PRESENCE_REGIONS) return false
    this.records.set(
      region.id,
      structuredClone({ ...region, rect: regionShapeBounds(region.shape) }),
    )
    return true
  }
  async updateRegion(id: string, shape: RegionShape, label: string): Promise<RegionClaim | null> {
    const current = this.records.get(id)
    if (current === undefined) return null
    const region = structuredClone({ ...current, shape, rect: regionShapeBounds(shape), label })
    this.records.set(id, region)
    return region
  }
  async deleteRegion(id: string): Promise<void> {
    this.records.delete(id)
  }
}
