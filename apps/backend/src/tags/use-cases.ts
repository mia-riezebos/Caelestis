import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  BackendStorageError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../runtime/errors.js'
import { publishManifestChange } from '../status-read-model/port.js'
import { TagConflictError, type TagMutation } from './store.js'

/** Read the reusable catalog and, optionally, one template's current assignments. */
export const readTags = (templateId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* Effect.tryPromise({
      try: async () => {
        const tags = await sql.listTags()
        if (templateId === undefined) return { tags, selected: [] as string[] }
        const template = await sql.readTemplate(templateId)
        if (template === null)
          throw new ResourceNotFoundError({ message: 'Template no longer exists.' })
        return { tags, selected: await sql.listTemplateTagIds(templateId) }
      },
      catch: (cause) =>
        cause instanceof ResourceNotFoundError
          ? cause
          : new BackendStorageError({ operation: 'readTags', cause }),
    })
  })

/** Commit authoritative metadata before notifying every affected manifest scope. */
export const mutateTag = (mutation: TagMutation, currentSeason: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readModel = yield* StatusReadModelService
    const scopes = yield* Effect.tryPromise({
      try: () => sql.listTagScopes(),
      catch: (cause) => new BackendStorageError({ operation: 'listTagScopes', cause }),
    })
    const changed = yield* Effect.tryPromise({
      try: () => sql.mutateTag(mutation, millis(Date.now())),
      catch: (cause) =>
        cause instanceof TagConflictError
          ? new ResourceConflictError({ message: cause.message })
          : new BackendStorageError({ operation: 'mutateTag', cause }),
    })
    if (!changed)
      return yield* Effect.fail(
        new ResourceNotFoundError({ message: 'Tag or template no longer exists.' }),
      )
    yield* Effect.promise(() =>
      Promise.all(
        [...new Set([currentSeason, ...scopes.map(({ season }) => season)])].map((season) =>
          publishManifestChange(readModel, season, undefined, false),
        ),
      ),
    )
    return { id: mutation.id }
  })
