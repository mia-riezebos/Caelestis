import {
  createWorkClient,
  isTemplateClaim,
  isWorkIdentity,
  type PainterIdentity,
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
  type WorkCollection,
  workClaimants,
} from '@caelestis/shared'
import type { TemplateClaimsModel, TemplateTreeModel } from '@caelestis/ui/elements'
import { allianceManifestFor } from '../alliance-server-sync.js'
import { rowsForSurface, serverTemplateTreeKey } from '../application/tree-server-state.js'
import { requestServerTree } from '../server-transport.js'
import {
  activeServerToken,
  admittedServerContentsFor,
  type ConnectedServer,
  commitState,
  getState,
  isCurrentServerConnection,
  serverConnectionSignal,
  serverEndpoint,
} from '../state.js'
import { isServerTemplate, localTemplates } from '../templates/local-store.js'
import { accountIdentity, loadAccount } from '../wplace-account.js'
import { toast } from './toast.js'
import type { TreeTarget } from './tree.js'

const workClient = (
  server: ConnectedServer,
  season: number,
  surface: TemplateSurface,
  signal: AbortSignal,
) =>
  createWorkClient(
    async (path, init) => {
      const headers = new Headers(init?.headers)
      const token = activeServerToken(server)
      if (token !== null) headers.set('authorization', `Bearer ${token}`)
      const { response, body } = await requestServerTree(serverEndpoint(server.url, path), {
        ...init,
        headers,
        signal,
      })
      return Response.json(body, { status: response.status })
    },
    season,
    surface,
  )

interface WorkPreview {
  readonly signal: AbortSignal
  revision: string
  collection: WorkCollection
  error: string
  request: number
}
const previews = new Map<string, WorkPreview>()
let identityChecked = false
let identityRequest: Promise<void> | null = null
const previewKey = (server: ConnectedServer, surface: TemplateSurface): string =>
  `${server.url}:${server.season}:${surface.kind}:${surface.allianceId}`

/** Aggregate template participants across admitted servers and local storage. Live revisions refresh remote claims. */
export const workSectionModel = (surface: TemplateSurface, changed: () => void) => {
  const templates = new Map<string, TemplateClaimsModel>()
  const errors: string[] = []
  const identity = accountIdentity()
  const painterId = identity?.wplaceUserId
  // The shared account cache bounds requests independently of server work revisions.
  if (identityRequest === null) {
    identityRequest = loadAccount().then(() => {
      identityRequest = null
      const needsRender = (!identityChecked && identity === null) || accountIdentity() !== identity
      identityChecked = true
      if (needsRender) changed()
    })
  }
  if (identityChecked && identity === null)
    errors.push('Wplace identity unavailable. Sign in, then retry.')
  let canShowOthers = false
  for (const server of getState().servers) {
    const contents =
      surface.kind === 'world'
        ? admittedServerContentsFor(server)
        : allianceManifestFor(server, surface)
    if (server.season === null || contents === null) continue
    const key = previewKey(server, surface)
    const signal = serverConnectionSignal(server)
    const revision = String(contents.workRevision ?? 'unversioned')
    let preview = previews.get(key)
    if (preview?.signal !== signal) {
      preview = {
        signal,
        revision: '',
        collection: { items: [], canPlan: false, canClaim: false },
        error: '',
        request: 0,
      }
      previews.set(key, preview)
      signal.addEventListener(
        'abort',
        () => {
          if (previews.get(key)?.signal === signal) previews.delete(key)
        },
        { once: true },
      )
    }
    if (preview.revision !== revision) {
      preview.revision = revision
      const held = preview
      const request = ++held.request
      void workClient(server, server.season, surface, signal)
        .list()
        .then(
          (collection) => {
            if (signal.aborted || held.request !== request) return
            held.collection = collection
            held.error = ''
            changed()
          },
          (error: unknown) => {
            if (signal.aborted || held.request !== request) return
            held.error = error instanceof Error ? error.message : String(error)
            changed()
          },
        )
    }
    canShowOthers ||= preview.collection.canPlan
    if (preview.error) errors.push(`${server.info?.name ?? server.url}: ${preview.error}`)
    for (const template of rowsForSurface(server, surface)?.templates ?? []) {
      const people = new Map<number, PainterIdentity>()
      for (const item of preview.collection.items) {
        if (!isTemplateClaim(item) || item.id !== template.id) continue
        for (const person of workClaimants(item)) people.set(person.wplaceUserId, person)
      }
      templates.set(serverTemplateTreeKey(server, template.id), {
        people: [...people.values()],
        mine: painterId !== undefined && people.has(painterId),
        canAssign: preview.collection.canPlan && template.published,
        canClaim: preview.collection.canClaim && template.published,
      })
    }
  }
  for (const template of localTemplates()) {
    if (
      isServerTemplate(template) ||
      !sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface)
    )
      continue
    const people = getState()
      .localClaims.filter((claim) => claim.templateId === template.id)
      .map((claim) => claim.claimant)
    templates.set(`local:${template.id}`, {
      people,
      mine: people.some((person) => person.wplaceUserId === painterId),
      canAssign: false,
      canClaim: true,
    })
  }
  return { templates, canShowOthers, error: errors.join('\n') }
}

/** Attach the same claim marker to ordinary rows and the flat In progress projection. */
export const withTemplateClaims = (
  tree: TemplateTreeModel,
  claims: ReturnType<typeof workSectionModel>,
  showOtherClaims?: boolean,
): TemplateTreeModel => {
  const entries = tree.entries.flatMap((entry) => {
    const participants = claims.templates.get(entry.key)
    if (
      showOtherClaims !== undefined &&
      (entry.type !== 'row' ||
        participants === undefined ||
        (!participants.mine &&
          !(showOtherClaims && participants.canAssign && participants.people.length > 0)))
    )
      return []
    if (entry.type !== 'row' || participants === undefined) return [entry]
    return [
      {
        ...entry,
        claims: participants,
        ...(showOtherClaims === undefined
          ? {}
          : { depth: 0, branches: [], parentKey: null, draggable: false }),
      },
    ]
  })
  return {
    ...tree,
    entries:
      showOtherClaims === undefined
        ? entries
        : entries.map((entry, index) =>
            entry.type === 'row'
              ? { ...entry, positionInSet: index + 1, setSize: entries.length }
              : entry,
          ),
  }
}

/** Apply a personal claim or an admin assignment, preserving every other painter's claim. */
export const claimTemplate = async (
  target: TreeTarget,
  changed: () => void,
  release = false,
  person?: PainterIdentity,
): Promise<void> => {
  await loadAccount()
  const actor = accountIdentity()
  if (!isWorkIdentity(actor)) {
    toast('Sign in to Wplace before claiming a template.', 'warning')
    return
  }
  const surface = target.surface ?? WORLD_TEMPLATE_SURFACE
  const server = target.server
  if (server === null) {
    if (!target.key.startsWith('local:') || person !== undefined) return
    const templateId = target.key.slice('local:'.length)
    const known = new Set(
      localTemplates()
        .filter((template) => !isServerTemplate(template))
        .map((template) => template.id),
    )
    if (!known.has(templateId)) return
    const remaining = getState().localClaims.filter(
      (claim) =>
        known.has(claim.templateId) &&
        !(claim.templateId === templateId && claim.claimant.wplaceUserId === actor.wplaceUserId),
    )
    if (
      !commitState({
        localClaims: release ? remaining : [...remaining, { templateId, claimant: actor }],
      })
    ) {
      toast('Could not save the local claim.', 'error')
      return
    }
    changed()
    return
  }
  if (
    server.season === null ||
    target.templateId === undefined ||
    !isCurrentServerConnection(server)
  )
    return
  const signal = serverConnectionSignal(server)
  const client = workClient(server, server.season, surface, signal)
  try {
    // A simultaneous claim changes the revision, not the ability to join the template.
    for (let attempt = 0; attempt < 3; attempt++) {
      const collection = await client.list()
      if (signal.aborted) return
      if (!collection.canClaim || (person !== undefined && !collection.canPlan)) {
        toast(
          person === undefined
            ? 'A report or admin token is required to claim templates on this server.'
            : 'An admin token is required to assign claims.',
          'warning',
        )
        return
      }
      const item = collection.items.find((candidate) => candidate.id === target.templateId)
      try {
        await client.mutate(target.templateId, {
          action:
            person === undefined
              ? release
                ? 'release-template'
                : 'claim-template'
              : release
                ? 'unassign-template'
                : 'assign-template',
          actor,
          expectedRevision: item?.revision ?? 0,
          ...(person === undefined ? {} : { claimant: person }),
        })
        break
      } catch (error) {
        if (!(error instanceof Error && 'status' in error && error.status === 409) || attempt === 2)
          throw error
      }
    }
    if (signal.aborted) return
    const preview = previews.get(previewKey(server, surface))
    if (preview !== undefined) {
      preview.revision = ''
      preview.request++
    }
    changed()
  } catch (error) {
    if (!signal.aborted) toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** Resolve row identity without depending on its folder being expanded. */
export const changeTemplateClaim = (
  key: string,
  surface: TemplateSurface,
  changed: () => void,
  release: boolean,
  person?: PainterIdentity,
): void => {
  if (key.startsWith('local:')) {
    void claimTemplate(
      { key, surface, server: null, nodeId: null, name: '' },
      changed,
      release,
      person,
    )
    return
  }
  for (const server of getState().servers) {
    const template = rowsForSurface(server, surface)?.templates.find(
      (candidate) => serverTemplateTreeKey(server, candidate.id) === key,
    )
    if (template === undefined) continue
    void claimTemplate(
      {
        key,
        surface,
        server,
        nodeId: template.nodeId,
        name: template.name,
        templateId: template.id,
      },
      changed,
      release,
      person,
    )
    return
  }
}

/** Use the last admitted claims to label the template's context action. */
export const hasOwnTemplateClaim = (target: TreeTarget): boolean => {
  const painterId = accountIdentity()?.wplaceUserId
  if (target.server === null)
    return getState().localClaims.some(
      (claim) =>
        `local:${claim.templateId}` === target.key && claim.claimant.wplaceUserId === painterId,
    )
  return (
    previews
      .get(previewKey(target.server, target.surface ?? WORLD_TEMPLATE_SURFACE))
      ?.collection.items.some(
        (item) =>
          isTemplateClaim(item) &&
          item.id === target.templateId &&
          workClaimants(item).some((person) => person.wplaceUserId === painterId),
      ) ?? false
  )
}

/** Hide claims on connections whose authoritative capability is read-only. */
export const canClaimTemplate = (target: TreeTarget): boolean =>
  target.server === null ||
  (previews.get(previewKey(target.server, target.surface ?? WORLD_TEMPLATE_SURFACE))?.collection
    .canClaim ??
    true)

/** Explicitly retry failed claim loads and the current Wplace identity without polling. */
export const retryTemplateClaims = (surface: TemplateSurface, changed: () => void): void => {
  for (const server of getState().servers) {
    const preview = previews.get(previewKey(server, surface))
    if (preview?.error) {
      preview.revision = ''
      preview.request++
    }
  }
  void loadAccount(0).then(changed)
  changed()
}
