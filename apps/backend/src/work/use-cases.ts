import {
  sameTemplateSurface,
  type TemplateSurface,
  uuidV7,
  type WorkItem,
  type WorkMutation,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { Caller } from '../auth/middleware.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  BackendStorageError,
  ForbiddenError,
  RequestValidationError,
  ResourceNotFoundError,
} from '../runtime/errors.js'
import { publishManifestChange } from '../status-read-model/port.js'

const storage = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackendStorageError({ operation: 'coordination', cause }),
  })
const invalid = (message: string) => Effect.fail(new RequestValidationError({ message }))

/** Read all work in one drawing scope. The bounded collection also supplies client-side filters. */
export const listWork = (season: number, surface: TemplateSurface) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* storage(() => sql.work.list(season, surface))
  })

/** Read activity newest first, with revision-based pagination. */
export const workHistory = (id: string, before: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    if ((yield* storage(() => sql.work.read(id))) === null)
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'Work item not found' }))
    return yield* storage(() => sql.work.history(id, before))
  })

/** Apply a scoped mutation. Claim identity is self-reported; server credentials enforce action scope. */
export const mutateWork = (
  id: string,
  season: number,
  surface: TemplateSurface,
  mutation: WorkMutation,
  caller: Caller,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const live = yield* StatusReadModelService
    const planning =
      mutation.action === 'create' || mutation.action === 'edit' || mutation.action === 'assign'
    if (caller.scope === 'read' || (planning && caller.scope !== 'admin')) {
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    }
    const held = yield* storage(() => sql.work.read(id))
    if (mutation.action !== 'create' && held === null)
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'Work item not found' }))
    if (held !== null && (held.season !== season || !sameTemplateSurface(held.surface, surface)))
      return yield* invalid('Work belongs to a different drawing scope')
    if (
      (held?.revision ?? 0) !== mutation.expectedRevision ||
      (mutation.action === 'create' && held !== null)
    ) {
      yield* storage(() => publishManifestChange(live, season, surface, false))
      return { conflict: true, item: held }
    }
    const fields =
      mutation.action === 'create' || mutation.action === 'edit' ? mutation.fields : held
    if (fields == null) return yield* invalid('Work fields are required')
    if (fields.blockerIds.includes(id)) return yield* invalid('Work cannot block itself')
    if (fields.nodeId !== null && fields.nodeId !== held?.nodeId) {
      const node = yield* storage(() => sql.readNode(fields.nodeId as string))
      if (node === null || node.season !== season || !sameTemplateSurface(node.surface, surface))
        return yield* invalid('Folder is missing or belongs to a different drawing scope')
    }
    for (const templateId of fields.templateIds) {
      if (held?.templateIds.includes(templateId)) continue
      const template = yield* storage(() => sql.readTemplate(templateId))
      if (
        template === null ||
        template.season !== season ||
        !sameTemplateSurface(template.surface, surface)
      )
        return yield* invalid('Linked template is missing or belongs to a different drawing scope')
      if (!template.published)
        return yield* invalid('Publish the template before linking shared work')
    }
    for (const blockerId of fields.blockerIds) {
      const blocker = yield* storage(() => sql.work.read(blockerId))
      if (
        blocker === null ||
        blocker.season !== season ||
        !sameTemplateSurface(blocker.surface, surface)
      )
        return yield* invalid('Blocker is missing or belongs to a different drawing scope')
    }
    let claimant = held?.claimant ?? null
    if (mutation.action === 'claim') {
      if (held?.status === 'completed')
        return yield* invalid('Reopen completed work before claiming it')
      if (claimant !== null) return { conflict: true, item: held }
      claimant = mutation.actor
    }
    if (mutation.action === 'release') {
      if (claimant?.wplaceUserId !== mutation.actor.wplaceUserId)
        return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
      claimant = null
    }
    if (mutation.action === 'assign') claimant = mutation.claimant ?? null
    const now = Date.now()
    const item: WorkItem = {
      title: fields.title.trim(),
      description: fields.description,
      status: fields.status,
      priority: fields.priority,
      tags: fields.tags,
      blockerIds: fields.blockerIds,
      nodeId: fields.nodeId,
      templateIds: fields.templateIds,
      id,
      season,
      surface,
      claimant,
      revision: (held?.revision ?? 0) + 1,
      createdAt: held?.createdAt ?? now,
      updatedAt: Math.max(held?.updatedAt ?? now, now),
    }
    const saved = yield* storage(() =>
      sql.work.save(
        item,
        mutation.expectedRevision,
        {
          id: uuidV7(),
          action: mutation.action,
          actor: mutation.actor,
          item,
        },
        caller.tokenHash,
      ),
    )
    // Even a stale retry repairs notification delivery after a previous committed write.
    yield* storage(() => publishManifestChange(live, season, surface, false))
    return { conflict: !saved, item: saved ? item : yield* storage(() => sql.work.read(id)) }
  })
