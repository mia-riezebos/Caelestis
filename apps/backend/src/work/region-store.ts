import type { RegionClaim, TemplateSurface } from '@caelestis/shared'

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
  deleteRegion(id: string): Promise<void>
}
