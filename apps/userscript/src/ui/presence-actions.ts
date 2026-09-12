import {
  type PresenceRect,
  type RegionClaim,
  type RegionDocument,
  rectCentreDistance,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  sameTemplateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { ClaimTool, PresenceSummaryModel } from '@caelestis/ui/elements'
import {
  type ClaimEditorHost,
  installClaimEditor,
  isClaimModeActive,
  startClaimMode,
} from '../claim-editor.js'
import {
  claimRegion,
  presenceLiveServer,
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
 * Region claims, from the drawer, the rail, and the keyboard.
 *
 * The editor owns drawing; this module owns what a claim means: which server it is saved to,
 * which template it happens to overlap, and how a saved claim comes back for editing.
 */

interface ClaimTarget {
  readonly template: PlacedTemplate
  readonly server: ConnectedServer
}

const pending = false
let message: string | undefined
let rerenderPanel: (() => void) | null = null

const templateRect = (template: PlacedTemplate): PresenceRect => ({
  x: template.originX,
  y: template.originY,
  w: template.width,
  h: template.height,
})

/** The server template overlapping `rect` whose overlap is centred nearest to it. */
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
      best = { template, server: template.serverConnection }
    }
  }
  return best
}

const serverFor = (region: RegionClaim): ConnectedServer | undefined =>
  presenceRegionServer(region.id) ?? undefined

/**
 * The one server claim mode edits: the one carrying the presence socket, else the first that
 * supports claims. Your regions there load together and are saved back as one claim.
 */
const claimServer = (): ConnectedServer | undefined => presenceLiveServer() ?? presenceServers()[0]

/** A short description of a document for lists and toasts. */
export const documentName = (document: RegionDocument): string => {
  const count = document.items.length
  const pixels = regionDocumentPixels(document)?.count ?? 0
  const first = document.items[0]?.shape.kind ?? 'shape'
  const kind = count === 1 ? first : `${count} shapes`
  return `${kind} · ${pixels.toLocaleString()} px`
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
      size: documentName(region.document),
    }))
  return {
    online: view.online,
    connected: view.connected,
    regions,
    canClaim: me !== null && view.connected && !isClaimModeActive(),
    ...(pending ? { pending: true } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

const host = (): ClaimEditorHost => ({
  templateFor: (document) => targetFor(regionDocumentBounds(document))?.template.name ?? null,
  myRegions: () => {
    const view = presenceView()
    const server = claimServer()
    return view.regions
      .filter(
        (region) =>
          region.claimant.wplaceUserId === view.me?.wplaceUserId &&
          server !== undefined &&
          serverFor(region)?.url === server.url,
      )
      .map((region) => ({ id: region.id, document: region.document }))
  },
  save: async (id, document) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    // Your regions live on the claim server. An overlapping template is only a hint, and only
    // when it lives on that same server.
    const server = (id === null ? null : presenceRegionServer(id)) ?? claimServer()
    if (server === undefined) return 'Presence is not connected to any server.'
    const target = targetFor(regionDocumentBounds(document))
    const hint = target !== null && target.server.url === server.url ? target.template.id : null
    const error = await claimRegion(server, id ?? uuidV7(), {
      templateId: hint,
      document,
      label: '',
      actor: me,
    })
    if (error === null) toast(`Saved your regions: ${documentName(document)}.`)
    return error
  },
  remove: async (id) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    const region = presenceView().regions.find((held) => held.id === id)
    if (region === undefined) return 'That claim is gone already.'
    const server = serverFor(region)
    if (server === undefined) return 'That claim belongs to a server that is no longer connected.'
    return releaseRegion(server, id, me)
  },
  changed: () => rerenderPanel?.(),
})

/** Wire the editor to this module once, before anything can open it. */
export const installClaimToolHost = (): void => {
  installClaimEditor(host())
}

const ready = (): boolean => {
  const view = presenceView()
  if (view.connected && view.me !== null) return true
  message =
    view.me === null
      ? 'Sign in to Wplace to claim regions.'
      : 'Connect to a server that supports painter presence to claim regions.'
  toast(message, 'error')
  rerenderPanel?.()
  return false
}

/** Enter claim mode with a tool in hand, from the rail, the drawer, or the M key. */
export const openClaimTool = (tool?: ClaimTool, rerender?: () => void): boolean => {
  if (rerender !== undefined) rerenderPanel = rerender
  if (!ready()) return false
  message = undefined
  installClaimEditor(host())
  startClaimMode(tool)
  return true
}

/** Enter claim mode from the drawer's Edit: every one of your regions loads, so the id is moot. */
export const openClaimEditor = (_id: string, rerender?: () => void): boolean =>
  openClaimTool('select', rerender)
