import {
  type PresenceRect,
  type RegionClaim,
  rectCentreDistance,
  rectIntersection,
  sameTemplateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { PresenceSummaryModel } from '@caelestis/ui/elements'
import { claimRegion, presencePending, presenceView, releaseRegion } from '../presence-client.js'
import type { ConnectedServer } from '../state.js'
import { isServerTemplate, localTemplates, type PlacedTemplate } from '../templates/local-store.js'
import { accountIdentity } from '../wplace-account.js'
import { toast } from './toast.js'

/**
 * Region claims from the In progress drawer.
 *
 * There is no drag gesture for a region. A painter claims what they already have: the part of a
 * template their viewport covers, or the bounds of the pixels they have drafted on it. Both are
 * rects the presence client is already tracking, so claiming is one click and one request.
 */

interface ClaimTarget {
  readonly template: PlacedTemplate
  readonly server: ConnectedServer
  readonly rect: PresenceRect
}

let pending = false
let message: string | undefined

const templateRect = (template: PlacedTemplate): PresenceRect => ({
  x: template.originX,
  y: template.originY,
  w: template.width,
  h: template.height,
})

/** The server template whose overlap with `rect` is centred nearest to it, and that overlap. */
const targetFor = (rect: PresenceRect | null): ClaimTarget | null => {
  if (rect === null) return null
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
      best = { template, server: template.serverConnection, rect: overlap }
    }
  }
  return best
}

const sizeOf = (rect: PresenceRect): string => `${rect.w} × ${rect.h}`

/** What the drawer shows: headcount, claims on this surface, and which claims are possible. */
export const presenceSummaryModel = (): PresenceSummaryModel | undefined => {
  const view = presenceView()
  if (!view.connected && view.regions.length === 0) return undefined
  const me = view.me
  const current = presencePending()
  const viewportTarget = targetFor(current.viewport)
  const draftTarget = targetFor(current.draft?.rect ?? null)
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
      size: sizeOf(region.rect),
    }))
  return {
    online: view.online,
    connected: view.connected,
    regions,
    canClaim: me !== null && view.connected,
    claimViewport: viewportTarget?.template.name ?? null,
    claimDraft: draftTarget?.template.name ?? null,
    ...(pending ? { pending: true } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

const finish = (error: string | null, success: string, rerender: () => void): void => {
  pending = false
  message = error ?? undefined
  if (error === null) toast(success)
  rerender()
}

export const claimPresenceRegion = (mode: 'viewport' | 'draft', rerender: () => void): void => {
  const me = accountIdentity()
  if (me === null || pending) return
  const current = presencePending()
  const target = targetFor(mode === 'viewport' ? current.viewport : (current.draft?.rect ?? null))
  if (target === null) {
    message =
      mode === 'viewport' ? 'No server template in view.' : 'Nothing drafted on a server template.'
    rerender()
    return
  }
  pending = true
  message = undefined
  rerender()
  void claimRegion(target.server, uuidV7(), {
    templateId: target.template.id,
    rect: target.rect,
    label: mode === 'draft' ? 'draft' : '',
    actor: me,
  }).then((error) =>
    finish(error, `Claimed ${sizeOf(target.rect)} of ${target.template.name}.`, rerender),
  )
}

export const releasePresenceRegion = (id: string, rerender: () => void): void => {
  const me = accountIdentity()
  if (me === null || pending) return
  const region = presenceView().regions.find((held) => held.id === id)
  if (region === undefined) return
  const server = localTemplates().find(
    (template) => template.id === region.templateId && template.serverConnection !== undefined,
  )?.serverConnection
  if (server === undefined) {
    message = 'That claim belongs to a server that is no longer connected.'
    rerender()
    return
  }
  pending = true
  message = undefined
  rerender()
  void releaseRegion(server, id, me).then((error) => finish(error, 'Region released.', rerender))
}
