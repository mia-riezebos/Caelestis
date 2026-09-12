import {
  type PresenceRect,
  type RegionClaim,
  type RegionShape,
  type RegionShapeKind,
  rectCentreDistance,
  rectIntersection,
  regionShapeBounds,
  sameTemplateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { PresenceSummaryModel } from '@caelestis/ui/elements'
import { type ClaimToolHost, isClaimToolActive, startClaimTool } from '../claim-tool.js'
import {
  claimRegion,
  presenceRegionServer,
  presenceServers,
  presenceView,
  releaseRegion,
} from '../presence-client.js'
import type { ConnectedServer } from '../state.js'
import { isServerTemplate, localTemplates, type PlacedTemplate } from '../templates/local-store.js'
import { accountIdentity } from '../wplace-account.js'
import { toast } from './toast.js'

/**
 * Region claims, from the drawer and the keyboard.
 *
 * The tool owns drawing; this module owns what a shape means: which server template it lands on,
 * which server to save it to, and how a saved claim comes back for editing.
 */

interface ClaimTarget {
  readonly template: PlacedTemplate
  readonly server: ConnectedServer
}

let pending = false
let message: string | undefined
let rerenderPanel: (() => void) | null = null

const templateRect = (template: PlacedTemplate): PresenceRect => ({
  x: template.originX,
  y: template.originY,
  w: template.width,
  h: template.height,
})

/** The server template overlapping `rect` whose overlap is centred nearest to it. */
const targetFor = (rect: PresenceRect): ClaimTarget | null => {
  let best: ClaimTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const template of localTemplates()) {
    if (
      !isServerTemplate(template) ||
      template.serverConnection === undefined ||
      !sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, WORLD_TEMPLATE_SURFACE)
    )
      continue
    const overlap = rectIntersection(rect, templateRect(template))
    if (overlap === null) continue
    const distance = rectCentreDistance(overlap, rect)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { template, server: template.serverConnection }
    }
  }
  return best
}

const serverFor = (region: RegionClaim): ConnectedServer | undefined =>
  presenceRegionServer(region.id) ?? undefined

const shapeName = (shape: RegionShape): string => {
  switch (shape.kind) {
    case 'rectangle':
      return `${shape.w} × ${shape.h}`
    case 'ellipse':
      return `ellipse ${shape.w} × ${shape.h}`
    case 'polygon':
      return `${shape.sides}-gon r${shape.r}`
    case 'star':
      return `${shape.points}-star r${shape.r}`
  }
}

/** What the drawer shows: headcount, claims on this surface, and whether the tool can open. */
export const presenceSummaryModel = (): PresenceSummaryModel | undefined => {
  const view = presenceView()
  if (!view.connected && view.regions.length === 0) return undefined
  const me = view.me
  const regions = [...view.regions]
    .sort((left, right) => {
      const mineLeft = left.claimant.wplaceUserId === me?.wplaceUserId ? 0 : 1
      const mineRight = right.claimant.wplaceUserId === me?.wplaceUserId ? 0 : 1
      return mineLeft - mineRight || right.createdAt - left.createdAt
    })
    .map((region: RegionClaim) => ({
      id: region.id,
      label: region.label,
      claimant: region.claimant.displayName,
      mine: region.claimant.wplaceUserId === me?.wplaceUserId,
      size: shapeName(region.shape),
    }))
  return {
    online: view.online,
    connected: view.connected,
    regions,
    canClaim: me !== null && view.connected && !isClaimToolActive(),
    ...(pending ? { pending: true } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

const host = (): ClaimToolHost => ({
  templateFor: (shape) => targetFor(regionShapeBounds(shape))?.template.name ?? null,
  myRegions: () => {
    const view = presenceView()
    return view.regions
      .filter((region) => region.claimant.wplaceUserId === view.me?.wplaceUserId)
      .map((region) => ({ id: region.id, shape: region.shape }))
  },
  save: async (id, shape) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    // A claim lives on a server, not on a template. An overlapping template only decides which
    // server gets it when several are connected, and is recorded as a hint.
    const target = targetFor(regionShapeBounds(shape))
    const server =
      (id === null ? null : presenceRegionServer(id)) ?? target?.server ?? presenceServers()[0]
    if (server === undefined) return 'Presence is not connected to any server.'
    const error = await claimRegion(server, id ?? uuidV7(), {
      templateId: target?.template.id ?? null,
      shape,
      label: '',
      actor: me,
    })
    if (error === null)
      toast(
        `${id === null ? 'Claimed' : 'Updated'} ${shapeName(shape)}${target === null ? '' : ` on ${target.template.name}`}.`,
      )
    return error
  },
  remove: async (id) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    const region = presenceView().regions.find((held) => held.id === id)
    if (region === undefined) return 'That claim is gone already.'
    const server = serverFor(region)
    if (server === undefined) return 'That claim belongs to a server that is no longer connected.'
    const error = await releaseRegion(server, id, me)
    if (error === null) toast('Region released.')
    return error
  },
  changed: () => rerenderPanel?.(),
})

/** Open the claim tool, from the drawer button or the M and L keys. */
export const openClaimTool = (kind?: RegionShapeKind, rerender?: () => void): boolean => {
  if (rerender !== undefined) rerenderPanel = rerender
  const view = presenceView()
  if (!view.connected || view.me === null) {
    message =
      view.me === null
        ? 'Sign in to Wplace to claim regions.'
        : 'Connect to a server that supports painter presence to claim regions.'
    toast(message, 'error')
    rerenderPanel?.()
    return false
  }
  message = undefined
  startClaimTool(host(), kind)
  return true
}

/** Register the panel's rerender so tool changes refresh the drawer. */
export const bindClaimToolPanel = (rerender: () => void): void => {
  rerenderPanel = rerender
}

export const releasePresenceRegion = (id: string, rerender: () => void): void => {
  const me = accountIdentity()
  if (me === null || pending) return
  const region = presenceView().regions.find((held) => held.id === id)
  if (region === undefined) return
  const server = serverFor(region)
  if (server === undefined) {
    message = 'That claim belongs to a server that is no longer connected.'
    rerender()
    return
  }
  pending = true
  message = undefined
  rerender()
  void releaseRegion(server, id, me).then((error) => {
    pending = false
    message = error ?? undefined
    if (error === null) toast('Region released.')
    rerender()
  })
}
