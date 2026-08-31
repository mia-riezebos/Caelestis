import type { ServerInfo } from '@caelestis/shared'

/** Apply mutable D1 settings without dropping transport capabilities configured at deploy time. */
export const mergeServerInfo = (
  base: ServerInfo,
  settings: { readonly name: string | null; readonly description: string | null },
): ServerInfo => {
  const description = settings.description ?? base.description
  const resolved = {
    id: base.id,
    name: settings.name ?? base.name,
    auth: base.auth,
    ...(base.liveSync === undefined ? {} : { liveSync: base.liveSync }),
    ...(base.liveTileOffers === undefined ? {} : { liveTileOffers: base.liveTileOffers }),
  }
  return description === undefined || description === null ? resolved : { ...resolved, description }
}
