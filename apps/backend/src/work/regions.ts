import {
  isRegionDocument,
  MAX_PRESENCE_REGION_PIXELS,
  type PainterIdentity,
  type RegionClaim,
  type RegionClaimRequest,
  regionDocumentBounds,
  sameTemplateSurface,
  type TemplateSurface,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { Caller } from '../auth/middleware.js'
import { presenceRectWithinSurface } from '../presence/geometry.js'
import { PresenceService, SqlStoreService } from '../runtime/backend-runtime.js'
import {
  BackendStorageError,
  ForbiddenError,
  RequestValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../runtime/errors.js'

const storage = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackendStorageError({ operation: 'regions', cause }),
  })

/** List a bounded surface or template's region claims. */
export const listRegions = (season: number, surface: TemplateSurface, templateId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* storage(() => sql.regions.listRegions(season, surface, templateId))
  })

/** Create a credential-owned claim or update its content and template hint as its owner or an administrator. */
export const putRegion = (
  id: string,
  season: number,
  surface: TemplateSurface,
  request: RegionClaimRequest,
  caller: Caller,
) =>
  Effect.gen(function* () {
    if (caller.scope === 'read')
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    const sql = yield* SqlStoreService
    const live = yield* PresenceService
    if (!isRegionDocument(request.document))
      return yield* Effect.fail(new RequestValidationError({ message: 'Invalid region document' }))
    const rect = regionDocumentBounds(request.document)
    if (rect === null)
      return yield* Effect.fail(
        new RequestValidationError({ message: 'Region document must contain an added shape' }),
      )
    if (!presenceRectWithinSurface(rect, surface))
      return yield* Effect.fail(
        new RequestValidationError({ message: 'Region is outside the drawing surface' }),
      )
    if (rect.w * rect.h > MAX_PRESENCE_REGION_PIXELS)
      return yield* Effect.fail(
        new RequestValidationError({ message: 'Region area exceeds limit' }),
      )
    const templateId = request.templateId ?? null
    if (typeof templateId === 'string') {
      const template = yield* storage(() => sql.readTemplate(templateId))
      if (
        template === null ||
        template.season !== season ||
        !sameTemplateSurface(template.surface, surface)
      )
        return yield* Effect.fail(
          new RequestValidationError({
            message: 'Template is missing or belongs to another drawing surface',
          }),
        )
    }
    let region = yield* storage(() => sql.regions.readRegion(id))
    let inserted = false
    if (region === null) {
      const created: RegionClaim = {
        id,
        season,
        surface,
        templateId,
        claimant: request.actor,
        document: request.document,
        rect,
        label: request.label,
        createdAt: Date.now(),
      }
      inserted = yield* storage(() => sql.regions.createRegion(created, caller.tokenHash))
      region = inserted ? created : yield* storage(() => sql.regions.readRegion(id))
    }
    if (region === null)
      return yield* Effect.fail(new ResourceConflictError({ message: 'Region limit reached' }))
    if (region.season !== season || !sameTemplateSurface(region.surface, surface))
      return yield* Effect.fail(new ResourceConflictError({ message: 'Region is already claimed' }))
    if (!inserted)
      region = yield* storage(() =>
        sql.regions.updateRegion(id, request.document, request.label, templateId, {
          tokenHash: caller.tokenHash,
          actorId: request.actor.wplaceUserId,
          admin: caller.scope === 'admin',
        }),
      )
    if (region === null) return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    yield* storage(() => live.publishRegions(season, surface))
    return region
  })

/** Only the owning credential with the claimant's ID, or an administrator, can remove a claim. */
export const deleteRegion = (id: string, actor: PainterIdentity, caller: Caller) =>
  Effect.gen(function* () {
    if (caller.scope === 'read')
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    const sql = yield* SqlStoreService
    const live = yield* PresenceService
    const region = yield* storage(() => sql.regions.readRegion(id))
    if (region === null)
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'Region not found' }))
    const deleted = yield* storage(() =>
      sql.regions.deleteRegion(id, {
        tokenHash: caller.tokenHash,
        actorId: actor.wplaceUserId,
        admin: caller.scope === 'admin',
      }),
    )
    if (!deleted) return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    yield* storage(() => live.publishRegions(region.season, region.surface))
    return { ok: true }
  })
