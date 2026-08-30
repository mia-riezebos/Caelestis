import { type Millis, millis, PngError, SliceError } from '@caelestis/shared'
import { Effect } from 'effect'
import type { TemplateDeletePrecondition, TemplatePatch } from '../ports/index.js'
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
import { readTileBlob } from '../telemetry/tile-blobs.js'
import {
  type StoredTemplate,
  StoreTemplateError,
  type StoreTemplateInput,
  storeTemplate,
} from './store.js'

type TemplateError =
  | RequestValidationError
  | ResourceNotFoundError
  | ResourceConflictError
  | BackendStorageError

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackendStorageError({ operation, cause }),
  })

/** Invalidate a status-affecting template commit without making projection loss data loss. */
const publishStatusProjection = (season: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readModel = yield* StatusReadModelService
    yield* Effect.promise(async () => {
      try {
        const revision = await sql.advanceStatusProjectionRevision(season)
        await readModel.applyCommittedChange({ season, revision })
      } catch (error) {
        // The template mutation is already authoritative. Reconciliation either observes the
        // revision gap or assigns a fresh revision after detecting changed content at the safety
        // boundary, so projection downtime must not report the accepted mutation as failed.
        console.error('status projection publication failed after template commit', error)
      }
    })
  })

const store = (
  operation: string,
  input: StoreTemplateInput,
  missingIsNotFound: boolean,
): Effect.Effect<StoredTemplate, TemplateError, BlobStoreService | SqlStoreService> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    return yield* Effect.tryPromise({
      try: () => storeTemplate({ blobs, sql }, input),
      catch: (cause): TemplateError => {
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
        if (missingIsNotFound && cause instanceof TemplateNotFoundError) {
          return new ResourceNotFoundError({ message: 'not found' })
        }
        return new BackendStorageError({ operation, cause })
      },
    })
  })

export interface CreateTemplateInput extends Omit<StoreTemplateInput, 'season'> {
  /** Omitted only when the route inherits the season from a supplied node. */
  readonly season?: number
}

export const createTemplate = (
  input: CreateTemplateInput,
): Effect.Effect<StoredTemplate, TemplateError, BlobStoreService | SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    let season = input.season
    if (season === undefined) {
      if (input.nodeId === null) {
        return yield* Effect.fail(
          new RequestValidationError({
            message: 'season must be a non-negative integer for a root template',
          }),
        )
      }
      const nodeId = input.nodeId
      const parent = yield* storage('readNode', () => sql.readNode(nodeId))
      if (parent === null) {
        return yield* Effect.fail(
          new RequestValidationError({
            message: `node does not exist: ${nodeId}`,
          }),
        )
      }
      season = parent.season
    }
    return yield* store('createTemplate', { ...input, season }, false)
  })

export const createTemplateVersion = (input: {
  readonly templateId: string
  readonly createdWithToken: string
  readonly createdByUserId: number | null
  readonly originX: number
  readonly originY: number
  readonly png: Uint8Array
}): Effect.Effect<
  StoredTemplate,
  TemplateError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const existing = yield* storage('readTemplate', () => sql.readTemplate(input.templateId))
    if (existing === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    if (existing.surface.kind === 'world' && (input.originX < 0 || input.originY < 0)) {
      return yield* Effect.fail(
        new RequestValidationError({
          message: 'originX and originY must be non-negative integers',
        }),
      )
    }
    const stored = yield* store(
      'createTemplateVersion',
      {
        ...input,
        surface: existing.surface,
        season: existing.season,
        nodeId: existing.nodeId,
        name: existing.name,
      },
      true,
    )
    yield* publishStatusProjection(existing.season)
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

export interface PatchedTemplate {
  readonly id: string
  readonly name?: string
  readonly nodeId?: string | null
  readonly published?: boolean
  readonly finished?: boolean
  readonly finishedAt?: Millis | null
  readonly timelapseFrozen?: boolean
  readonly updatedAt: Millis
}

export const patchTemplate = (
  input: PatchTemplateInput,
): Effect.Effect<PatchedTemplate, TemplateError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    if (input.timelapseFrozen === false && input.finished !== false) {
      const current = yield* storage('readTemplate', () => sql.readTemplate(input.templateId))
      if (current?.finished === true) {
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
      const current = yield* storage('readTemplate', () => sql.readTemplate(input.templateId))
      return yield* Effect.fail(
        current === null
          ? new ResourceNotFoundError({ message: 'not found' })
          : new ResourceConflictError({
              message: 'template changed concurrently',
            }),
      )
    }

    if (input.published !== undefined) {
      const committed = yield* storage('readTemplate', () => sql.readTemplate(input.templateId))
      if (committed !== null) yield* publishStatusProjection(committed.season)
    }

    return {
      id: input.templateId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.published === undefined ? {} : { published: input.published }),
      ...(input.finished === undefined
        ? {}
        : {
            finished: input.finished,
            finishedAt: input.finished ? now : null,
          }),
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
  expected: TemplateDeletePrecondition,
): Effect.Effect<
  void,
  ResourceNotFoundError | ResourceConflictError | BackendStorageError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const before = yield* storage('readTemplate', () => sql.readTemplate(templateId))
    if (before === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const deleted = yield* storage('deleteTemplate', () => sql.deleteTemplate(templateId, expected))
    if (deleted) {
      yield* publishStatusProjection(before.season)
      return
    }
    const current = yield* storage('readTemplate', () => sql.readTemplate(templateId))
    return yield* Effect.fail(
      current === null
        ? new ResourceNotFoundError({ message: 'not found' })
        : new ResourceConflictError({
            message: 'template changed concurrently',
          }),
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
    const bytes = yield* storage('readBlob', () =>
      namespace === 'tiles' ? readTileBlob({ blobs, sql }, hash) : blobs.get(namespace, hash),
    )
    if (bytes === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    return new Uint8Array(bytes)
  })
