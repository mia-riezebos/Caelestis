import type { AllianceTemplateSurfaceKind, PixelBounds, TemplateSurface } from '@caelestis/shared'
import { pageWindow } from './page-world.js'
import { captureFetchUrlGetters, urlForFetchInput } from './wplace-raster.js'

const HQ_STAGE = 'dialog[open] [role="application"][aria-label="Headquarters canvas"]'
const ASSET_STAGE = 'dialog[open] [role="application"][aria-label="Alliance asset canvas"]'
const ARTBOARD_FRAME = '.artboard-frame'
const BACKEND_ORIGIN = 'https://backend.wplace.live'
const DRAFT_CANVAS = /^\/alliance\/assets\/drafts\/(\d+)\/canvas$/
const PUBLIC_HEADQUARTERS = /^\/alliances\/(\d+)\/headquarters(?:\/|$)/

export interface ActiveAllianceSurface {
  readonly surface: Exclude<TemplateSurface, { readonly kind: 'world' }>
  readonly stage: HTMLElement
  readonly frame: HTMLElement
  /** Present when the request observer saw Wplace's disposable picture/banner draft id. */
  readonly draftId: number | null
  /** Signed, half-open HQ bounds when Wplace has supplied them. */
  readonly bounds: PixelBounds | null
}

type Listener = (surface: ActiveAllianceSurface | null) => void

let active: ActiveAllianceSurface | null = null
let installed = false
let observer: MutationObserver | null = null
let restoreFetch: (() => void) | null = null
let reconcileQueued = false
let memberAllianceId: number | null = null
let headquarters: {
  readonly allianceId: number
  readonly bounds: PixelBounds | null
} | null = null
let draft: {
  readonly id: number
  readonly kind: AllianceTemplateSurfaceKind
} | null = null
let pendingDraft: {
  readonly id: number
  readonly sequence: number
  readonly previousKind: AllianceTemplateSurfaceKind | null
} | null = null
let memberSequence = 0
let acceptedMemberSequence = 0
let headquartersSequence = 0
let acceptedHeadquartersSequence = 0
let draftSequence = 0
let acceptedDraftSequence = 0
let allianceEpoch = 0
const listeners = new Set<Listener>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null

const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? Number(value) : null

const parseHqBounds = (value: unknown): PixelBounds | null => {
  if (!isRecord(value)) return null
  const minX = integer(value.minX)
  const minY = integer(value.minY)
  const inclusiveMaxX = integer(value.maxX)
  const inclusiveMaxY = integer(value.maxY)
  if (
    minX === null ||
    minY === null ||
    inclusiveMaxX === null ||
    inclusiveMaxY === null ||
    minX < -1_000 ||
    minY < -1_000 ||
    inclusiveMaxX >= 1_000 ||
    inclusiveMaxY >= 1_000 ||
    minX > inclusiveMaxX ||
    minY > inclusiveMaxY
  ) {
    return null
  }
  return { minX, minY, maxX: inclusiveMaxX + 1, maxY: inclusiveMaxY + 1 }
}

const sameBounds = (left: PixelBounds | null, right: PixelBounds | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY)

const sameActive = (left: ActiveAllianceSurface | null, right: ActiveAllianceSurface | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.stage === right.stage &&
    left.frame === right.frame &&
    left.surface.kind === right.surface.kind &&
    left.surface.allianceId === right.surface.allianceId &&
    left.draftId === right.draftId &&
    sameBounds(left.bounds, right.bounds))

const assetKindFromCanvas = (frame: HTMLElement): AllianceTemplateSurfaceKind | null => {
  for (const child of frame.children) {
    if (child.tagName !== 'CANVAS') continue
    const canvas = child as HTMLCanvasElement
    if (canvas.width === 64 && canvas.height === 64) return 'alliance-picture'
    if (canvas.width === 384 && canvas.height === 128) return 'alliance-banner'
  }
  return null
}

const publish = (next: ActiveAllianceSurface | null): void => {
  if (sameActive(active, next)) return
  active = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      // Page lifecycle observation must never break Wplace because one consumer failed.
    }
  }
}

const reconcile = (): void => {
  reconcileQueued = false
  const realm = pageWindow()
  const hqStage = realm.document.querySelector<HTMLElement>(HQ_STAGE)
  const hqAllianceId = headquarters?.allianceId ?? memberAllianceId
  if (hqStage !== null && hqAllianceId !== null) {
    const frame = hqStage.querySelector<HTMLElement>(ARTBOARD_FRAME)
    if (frame !== null) {
      publish({
        surface: { kind: 'alliance-headquarters', allianceId: hqAllianceId },
        stage: hqStage,
        frame,
        draftId: null,
        bounds: headquarters?.allianceId === hqAllianceId ? headquarters.bounds : null,
      })
      return
    }
  }

  const assetStage = realm.document.querySelector<HTMLElement>(ASSET_STAGE)
  if (assetStage !== null && memberAllianceId !== null) {
    const frame = assetStage.querySelector<HTMLElement>(ARTBOARD_FRAME)
    if (frame !== null) {
      // Wplace reuses this frame while switching picture and banner. Until the new draft metadata
      // wins, the native canvas can still have the previous asset's dimensions and must not select
      // the previous manifest for the new editor.
      const canvasKind = assetKindFromCanvas(frame)
      if (pendingDraft !== null && canvasKind === pendingDraft.previousKind) {
        publish(null)
        return
      }
      // Wplace may reuse a cached draft without issuing the metadata request after a late dev
      // injection. The two asset canvases have fixed, disjoint dimensions, so their native
      // artboard canvas is a safe fallback for kind detection; the request still owns the draft id.
      const kind = draft?.kind ?? canvasKind ?? null
      if (kind === null) {
        publish(null)
        return
      }
      publish({
        surface: { kind, allianceId: memberAllianceId },
        stage: assetStage,
        frame,
        draftId: draft?.kind === kind ? draft.id : null,
        bounds: null,
      })
      return
    }
  }
  publish(null)
}

const queueReconcile = (): void => {
  if (reconcileQueued) return
  reconcileQueued = true
  queueMicrotask(reconcile)
}

const readJson = (response: Response, accept: (body: unknown) => void): void => {
  if (!response.ok) return
  try {
    void response
      .clone()
      .json()
      .then(accept)
      .catch(() => {})
  } catch {
    // A response that cannot be cloned is simply not an observable context source.
  }
}

const observeMemberAlliance = (response: Response, sequence: number): void => {
  readJson(response, (body) => {
    if (sequence < acceptedMemberSequence || !isRecord(body)) return
    const nextAllianceId = positiveInteger(body.id)
    if (nextAllianceId === null) return
    acceptedMemberSequence = sequence
    if (memberAllianceId !== null && memberAllianceId !== nextAllianceId) allianceEpoch++
    if (memberAllianceId !== nextAllianceId) {
      const previous = memberAllianceId
      memberAllianceId = nextAllianceId
      draft = null
      if (headquarters?.allianceId === previous) headquarters = null
    }
    queueReconcile()
  })
}

const selectHeadquartersRequest = (nextAllianceId: number | null, sequence: number): void => {
  acceptedHeadquartersSequence = sequence
  headquarters =
    nextAllianceId === null
      ? null
      : {
          allianceId: nextAllianceId,
          bounds: headquarters?.allianceId === nextAllianceId ? headquarters.bounds : null,
        }
  queueReconcile()
}

const observeHeadquarters = (
  response: Response,
  sequence: number,
  knownAllianceId?: number,
): void => {
  readJson(response, (body) => {
    if (sequence < acceptedHeadquartersSequence || !isRecord(body)) return
    const nextAllianceId = knownAllianceId ?? positiveInteger(body.allianceId)
    if (nextAllianceId === null) return
    acceptedHeadquartersSequence = sequence
    headquarters = { allianceId: nextAllianceId, bounds: parseHqBounds(body.bounds) }
    queueReconcile()
  })
}

const observeDraft = (
  response: Response,
  sequence: number,
  requestedDraftId: number,
  requestAllianceEpoch: number,
): void => {
  const finish = (): void => {
    if (pendingDraft?.sequence !== sequence) return
    pendingDraft = null
    queueReconcile()
  }
  if (!response.ok) {
    finish()
    return
  }
  try {
    void response
      .clone()
      .json()
      .then((body: unknown) => {
        if (
          requestAllianceEpoch !== allianceEpoch ||
          sequence < acceptedDraftSequence ||
          !isRecord(body)
        )
          return
        const responseDraftId =
          body.draftId === undefined ? requestedDraftId : positiveInteger(body.draftId)
        if (responseDraftId !== requestedDraftId) return
        const kind =
          body.assetType === 'picture'
            ? ('alliance-picture' as const)
            : body.assetType === 'banner'
              ? ('alliance-banner' as const)
              : null
        if (kind === null) return
        acceptedDraftSequence = sequence
        draft = { id: requestedDraftId, kind }
      })
      .catch(() => {})
      .finally(finish)
  } catch {
    finish()
  }
}

const selectDraftRequest = (id: number): { readonly sequence: number; readonly epoch: number } => {
  const sequence = ++draftSequence
  const previousKind =
    active?.surface.kind === 'alliance-picture' || active?.surface.kind === 'alliance-banner'
      ? active.surface.kind
      : null
  acceptedDraftSequence = sequence
  draft = null
  pendingDraft = { id, sequence, previousKind }
  queueReconcile()
  return { sequence, epoch: allianceEpoch }
}

const installFetchObserver = (realm: Window & typeof globalThis): (() => void) | null => {
  const previous = realm.fetch
  const urlGetters = captureFetchUrlGetters(realm)
  const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>) {
    let observation:
      | { readonly kind: 'alliance'; readonly sequence: number }
      | { readonly kind: 'hq'; readonly sequence: number }
      | { readonly kind: 'public-hq'; readonly sequence: number; readonly allianceId: number }
      | {
          readonly kind: 'draft'
          readonly sequence: number
          readonly draftId: number
          readonly allianceEpoch: number
        }
      | null = null
    let draftValidation: {
      readonly pending: Promise<Response>
      readonly sequence: number
      readonly draftId: number
      readonly allianceEpoch: number
    } | null = null
    try {
      const raw = urlForFetchInput(args[0], realm, urlGetters)
      if (raw !== null) {
        const url = new URL(raw, realm.location?.href)
        if (url.origin === BACKEND_ORIGIN) {
          const publicHq = PUBLIC_HEADQUARTERS.exec(url.pathname)
          const publicAllianceId = publicHq === null ? null : positiveInteger(Number(publicHq[1]))
          const publicSequence = publicAllianceId === null ? null : ++headquartersSequence
          if (publicAllianceId !== null && publicSequence !== null) {
            selectHeadquartersRequest(publicAllianceId, publicSequence)
          }
          if (
            publicAllianceId !== null &&
            publicSequence !== null &&
            (url.pathname === `/alliances/${publicAllianceId}/headquarters` ||
              url.pathname === `/alliances/${publicAllianceId}/headquarters/manifest`)
          ) {
            observation = {
              kind: 'public-hq',
              sequence: publicSequence,
              allianceId: publicAllianceId,
            }
          } else if (url.pathname === '/alliance') {
            observation = { kind: 'alliance', sequence: ++memberSequence }
          } else if (url.pathname === '/alliance/headquarters') {
            const sequence = ++headquartersSequence
            selectHeadquartersRequest(memberAllianceId, sequence)
            observation = { kind: 'hq', sequence }
          } else {
            const match = DRAFT_CANVAS.exec(url.pathname)
            const id = match === null ? null : positiveInteger(Number(match[1]))
            if (id !== null && url.searchParams.get('metadataOnly') === 'true') {
              const selected = selectDraftRequest(id)
              observation = {
                kind: 'draft',
                sequence: selected.sequence,
                draftId: id,
                allianceEpoch: selected.epoch,
              }
            } else if (id !== null) {
              const selected = selectDraftRequest(id)
              const metadataUrl = new URL(url)
              metadataUrl.searchParams.set('metadataOnly', 'true')
              draftValidation = {
                pending: previous.call(realm, metadataUrl.href, { credentials: 'include' }),
                sequence: selected.sequence,
                draftId: id,
                allianceEpoch: selected.epoch,
              }
            }
          }
        }
      }
    } catch {
      // Unusual fetch inputs remain fully transparent; they simply carry no observable context.
    }

    const pending = previous.apply(this as never, args)
    if (draftValidation !== null) {
      void draftValidation.pending.then(
        (response) =>
          observeDraft(
            response,
            draftValidation.sequence,
            draftValidation.draftId,
            draftValidation.allianceEpoch,
          ),
        () => {
          if (pendingDraft?.sequence !== draftValidation?.sequence) return
          pendingDraft = null
          queueReconcile()
        },
      )
    }
    if (observation === null) return pending
    return pending.then((response) => {
      if (observation.kind === 'draft') {
        observeDraft(response, observation.sequence, observation.draftId, observation.allianceEpoch)
      } else if (observation.kind === 'alliance') {
        observeMemberAlliance(response, observation.sequence)
      } else {
        observeHeadquarters(
          response,
          observation.sequence,
          observation.kind === 'public-hq' ? observation.allianceId : undefined,
        )
      }
      return response
    })
  } as typeof fetch

  try {
    realm.fetch = wrapped
  } catch {
    return null
  }
  if (realm.fetch !== wrapped) return null
  return () => {
    if (realm.fetch === wrapped) realm.fetch = previous
  }
}

/** Install the request and DOM observers at document-start. Idempotent. */
export const installAllianceSurfaceObserver = (): void => {
  if (installed) return
  installed = true
  const realm = pageWindow()
  restoreFetch = installFetchObserver(realm)
  observer = new realm.MutationObserver(queueReconcile)
  observer.observe(realm.document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'aria-label', 'role', 'class'],
  })
  // A late dev injection may have missed Wplace's bootstrap request. One read restores the stable
  // alliance id; signed-out users and users without an alliance simply leave the context unknown.
  void realm.fetch(`${BACKEND_ORIGIN}/alliance`, { credentials: 'include' }).catch(() => undefined)
  queueReconcile()
}

export const activeAllianceSurface = (): ActiveAllianceSurface | null => active

export const onActiveAllianceSurfaceChange = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only lifecycle reset; harmless when called during teardown in a page. */
export const resetAllianceSurfaceObserver = (): void => {
  observer?.disconnect()
  restoreFetch?.()
  observer = null
  restoreFetch = null
  installed = false
  reconcileQueued = false
  memberAllianceId = null
  headquarters = null
  draft = null
  pendingDraft = null
  memberSequence = 0
  acceptedMemberSequence = 0
  headquartersSequence = 0
  acceptedHeadquartersSequence = 0
  draftSequence = 0
  acceptedDraftSequence = 0
  allianceEpoch = 0
  active = null
  listeners.clear()
}
