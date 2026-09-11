import {
  type PainterIdentity,
  type RegionClaim,
  type RegionClaimRequest,
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

/** Create an immutable claim; replaying an ID repairs delivery without changing the record. */
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
    if (!presenceRectWithinSurface(request.rect, surface))
      return yield* Effect.fail(
        new RequestValidationError({ message: 'Region is outside the drawing surface' }),
      )
    const template = yield* storage(() => sql.readTemplate(request.templateId))
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
    let region = yield* storage(() => sql.regions.readRegion(id))
    if (region === null) {
      const created: RegionClaim = {
        id,
        season,
        surface,
        templateId: request.templateId,
        claimant: request.actor,
        rect: request.rect,
        label: request.label,
        createdAt: Date.now(),
      }
      const saved = yield* storage(() => sql.regions.createRegion(created))
      region = saved ? created : yield* storage(() => sql.regions.readRegion(id))
    }
    if (region === null)
      return yield* Effect.fail(new ResourceConflictError({ message: 'Region limit reached' }))
    if (
      region.claimant.wplaceUserId !== request.actor.wplaceUserId ||
      region.season !== season ||
      !sameTemplateSurface(region.surface, surface)
    )
      return yield* Effect.fail(new ResourceConflictError({ message: 'Region is already claimed' }))
    yield* storage(() => live.publishRegions(season, surface))
    return region
  })

/** Only the claimant or an administrator can remove a persisted claim. */
export const deleteRegion = (id: string, actor: PainterIdentity, caller: Caller) =>
  Effect.gen(function* () {
    if (caller.scope === 'read')
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    const sql = yield* SqlStoreService
    const live = yield* PresenceService
    const region = yield* storage(() => sql.regions.readRegion(id))
    if (region === null)
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'Region not found' }))
    if (caller.scope !== 'admin' && actor.wplaceUserId !== region.claimant.wplaceUserId)
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    yield* storage(() => sql.regions.deleteRegion(id))
    yield* storage(() => live.publishRegions(region.season, region.surface))
    return { ok: true }
  })
