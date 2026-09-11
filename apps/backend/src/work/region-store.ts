import type { RegionClaim, RegionShape, TemplateSurface } from '@caelestis/shared'

/** Persisted claims; creation never overwrites an existing identity. */
export interface RegionStore {
  listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]>
  readRegion(id: string): Promise<RegionClaim | null>
  /** Returns false when the ID exists or this surface has reached its claim limit. */
  createRegion(region: RegionClaim): Promise<boolean>
  /** Update shape, derived bounds, and label while retaining the claim's identity and creation time. */
  updateRegion(id: string, shape: RegionShape, label: string): Promise<RegionClaim | null>
  deleteRegion(id: string): Promise<void>
}
