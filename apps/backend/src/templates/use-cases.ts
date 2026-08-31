import { type Millis, millis, PngError, SliceError, type TemplateSurface } from '@caelestis/shared'
import { Effect } from 'effect'
import type { TemplatePatch } from '../ports/index.js'
import {
  InvalidNodeParentError,
  NodeNotFoundError,
  TemplateIdentityError,
  TemplateNotFoundError,
} from '../ports/index.js'
import {
  BlobStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import {
  BackendStorageError,
  RequestValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../runtime/errors.js'
import {
  publishManifestChange,
  repairCommittedStatusProjection,
} from '../status-read-model/port.js'
import { readTileBlob } from '../telemetry/tile-blobs.js'
import { type StoredTemplate, StoreTemplateError, storeTemplate } from './store.js'

type TemplateError =
  | RequestValidationError
  | ResourceNotFoundError
  | ResourceConflictError
  | BackendStorageError

const WHOLE_NUMBER = /^(0|[1-9]\d*)$/
const INTEGER = /^(?:0|-?[1-9]\d*)$/

const parseInteger = (value: unknown, signed: boolean): number | null => {
  if (typeof value !== 'string' || !(signed ? INTEGER : WHOLE_NUMBER).test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const templateFailure = (operation: string, cause: unknown): TemplateError => {
  if (
    cause instanceof PngError ||
    cause instanceof SliceError ||
    cause instanceof StoreTemplateError ||
    cause instanceof NodeNotFoundError
  ) {
    return new RequestValidationError({ message: cause.message })
  }
  if (cause instanceof TemplateIdentityError) {
    return new ResourceConflictError({ message: cause.message })
  }
  if (cause instanceof TemplateNotFoundError) {
    return new ResourceNotFoundError({ message: 'not found' })
  }
  return new BackendStorageError({ operation, cause })
}

export interface CreateTemplateInput {
  readonly surface: TemplateSurface
  readonly season?: number
  readonly nodeId: string | null
  readonly name: string
  readonly createdWithToken: string
  readonly originX: number
  readonly originY: number
  readonly png: Uint8Array
}

export const createTemplate = (
  input: CreateTemplateInput,
): Effect.Effect<
  StoredTemplate,
  TemplateError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    let season = input.season
    if (season === undefined) {
      if (input.nodeId === null) {
        return yield* Effect.fail(
          new RequestValidationError({
            message: 'season must be a non-negative integer for a root template',
          }),
        )
      }
      const parent = yield* Effect.tryPromise({
        try: () => sql.readNode(input.nodeId as string),
        catch: (cause) => new BackendStorageError({ operation: 'readNode', cause }),
      })
      if (parent === null) {
        return yield* Effect.fail(
          new RequestValidationError({ message: `node does not exist: ${input.nodeId}` }),
        )
      }
      season = parent.season
    }

    const stored = yield* Effect.tryPromise({
      try: () =>
        storeTemplate(blobs, sql, {
          surface: input.surface,
          season,
          nodeId: input.nodeId,
          name: input.name,
          createdWithToken: input.createdWithToken,
          createdByUserId: null,
          originX: input.originX,
          originY: input.originY,
          png: input.png,
        }),
      catch: (cause) => templateFailure('storeTemplate', cause),
    })
    yield* Effect.promise(() => publishManifestChange(statusReadModel, season, input.surface))
    return stored
  })

export const replaceTemplateVersion = (input: {
  readonly templateId: string
  readonly createdWithToken: string
  readonly originX: unknown
  readonly originY: unknown
  readonly png: Uint8Array
}): Effect.Effect<
  StoredTemplate,
  TemplateError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const existing = yield* Effect.tryPromise({
      try: () => sql.readTemplate(input.templateId),
      catch: (cause) => new BackendStorageError({ operation: 'readTemplate', cause }),
    })
    if (existing === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const signed = existing.surface.kind !== 'world'
    const originX = parseInteger(input.originX, signed)
    const originY = parseInteger(input.originY, signed)
    if (originX === null || originY === null) {
      return yield* Effect.fail(
        new RequestValidationError({
          message: signed
            ? 'originX and originY must be integers'
            : 'originX and originY must be non-negative integers',
        }),
      )
    }

    const stored = yield* Effect.tryPromise({
      try: () =>
        storeTemplate(blobs, sql, {
          templateId: input.templateId,
          surface: existing.surface,
          season: existing.season,
          nodeId: existing.nodeId,
          name: existing.name,
          createdWithToken: input.createdWithToken,
          createdByUserId: null,
          originX,
          originY,
          png: input.png,
        }),
      catch: (cause) => templateFailure('replaceTemplateVersion', cause),
    })
    yield* Effect.promise(() => repairCommittedStatusProjection(statusReadModel, existing.season))
    yield* Effect.promise(() =>
      publishManifestChange(statusReadModel, existing.season, existing.surface),
    )
    return stored
  })

export interface PatchTemplateInput {
  readonly templateId: string
  readonly name?: string
  readonly nodeId?: string | null
  readonly published?: boolean
  readonly timelapseFrozen?: boolean
  readonly finished?: boolean
}

export const patchTemplate = (
  input: PatchTemplateInput,
): Effect.Effect<
  Record<string, unknown>,
  TemplateError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const existing = yield* Effect.tryPromise({
      try: () => sql.readTemplate(input.templateId),
      catch: (cause) => new BackendStorageError({ operation: 'readTemplate', cause }),
    })
    if (existing === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    if (input.timelapseFrozen === false && input.finished !== false) {
      if (existing.finished === true) {
        return yield* Effect.fail(
          new RequestValidationError({
            message: 'reopen the template before thawing its timelapse',
          }),
        )
      }
    }

    const now = millis(Date.now())
    const patch: TemplatePatch = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.published === undefined ? {} : { publishedAt: input.published ? now : null }),
      ...(input.finished === true
        ? { finishedAt: now, timelapseFrozenAt: now }
        : {
            ...(input.finished === false ? { finishedAt: null } : {}),
            ...(input.timelapseFrozen === undefined
              ? {}
              : { timelapseFrozenAt: input.timelapseFrozen ? now : null }),
          }),
    }
    const updated = yield* Effect.tryPromise({
      try: () => sql.updateTemplate(input.templateId, patch, now),
      catch: (cause): RequestValidationError | BackendStorageError =>
        cause instanceof NodeNotFoundError || cause instanceof InvalidNodeParentError
          ? new RequestValidationError({ message: cause.message })
          : new BackendStorageError({ operation: 'updateTemplate', cause }),
    })
    if (!updated) {
      const current = yield* Effect.tryPromise({
        try: () => sql.readTemplate(input.templateId),
        catch: (cause) => new BackendStorageError({ operation: 'readTemplate', cause }),
      })
      if (current === null) {
        return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
      }
      return yield* Effect.fail(
        new ResourceConflictError({ message: 'template changed concurrently' }),
      )
    }

    if (input.published !== undefined) {
      yield* Effect.promise(() => repairCommittedStatusProjection(statusReadModel, existing.season))
    }
    yield* Effect.promise(() =>
      publishManifestChange(statusReadModel, existing.season, existing.surface),
    )

    return {
      id: input.templateId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.published === undefined ? {} : { published: input.published }),
      ...(input.finished === undefined
        ? {}
        : { finished: input.finished, finishedAt: input.finished ? now : null }),
      ...(input.finished === true
        ? { timelapseFrozen: true }
        : input.timelapseFrozen === undefined
          ? {}
          : { timelapseFrozen: input.timelapseFrozen }),
      updatedAt: now,
    }
  })

export const deleteTemplate = (
  templateId: string,
  expected: { readonly versionId: string; readonly updatedAt: Millis },
): Effect.Effect<
  void,
  ResourceNotFoundError | ResourceConflictError | BackendStorageError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const existing = yield* Effect.tryPromise({
      try: () => sql.readTemplate(templateId),
      catch: (cause) => new BackendStorageError({ operation: 'readTemplate', cause }),
    })
    if (existing === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const deleted = yield* Effect.tryPromise({
      try: () => sql.deleteTemplate(templateId, expected),
      catch: (cause) => new BackendStorageError({ operation: 'deleteTemplate', cause }),
    })
    if (deleted) {
      yield* Effect.promise(() => repairCommittedStatusProjection(statusReadModel, existing.season))
      yield* Effect.promise(() =>
        publishManifestChange(statusReadModel, existing.season, existing.surface),
      )
      return
    }
    const current = yield* Effect.tryPromise({
      try: () => sql.readTemplate(templateId),
      catch: (cause) => new BackendStorageError({ operation: 'readTemplate', cause }),
    })
    if (current === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    return yield* Effect.fail(
      new ResourceConflictError({ message: 'template changed concurrently' }),
    )
  })

export const readBlob = (
  namespace: 'chunks' | 'tiles',
  hash: string,
): Effect.Effect<
  Uint8Array,
  ResourceNotFoundError | BackendStorageError,
  BlobStoreService | SqlStoreService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const bytes = yield* Effect.tryPromise({
      try: () =>
        namespace === 'tiles' ? readTileBlob({ blobs, sql }, hash) : blobs.get(namespace, hash),
      catch: (cause) => new BackendStorageError({ operation: `read ${namespace} blob`, cause }),
    })
    if (bytes === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    return bytes
  })
