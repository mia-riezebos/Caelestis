import { millis, nodeSlug, type TemplateSurface, uuidV7 } from '@caelestis/shared'
import { Effect } from 'effect'
import type { NodeDeletion, NodeRecord } from '../ports/index.js'
import {
  InvalidNodeParentError,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
  NodePathTooLongError,
  NodeSubtreeChangedError,
} from '../ports/index.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  BackendStorageError,
  RequestValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../runtime/errors.js'
import { repairCommittedStatusProjection } from '../status-read-model/port.js'

type NodeError =
  | RequestValidationError
  | ResourceNotFoundError
  | ResourceConflictError
  | BackendStorageError

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackendStorageError({ operation, cause }),
  })

export const publicNode = ({ season: _season, surface: _surface, description, ...node }: NodeRecord) =>
  description === null ? node : { ...node, description }

export const createNode = (input: {
  readonly season: number
  readonly surface: TemplateSurface
  readonly parentId: string | null
  readonly name: string
  readonly description?: string
}): Effect.Effect<ReturnType<typeof publicNode>, NodeError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const segment = nodeSlug(input.name)
    let parentPath = ''
    if (input.parentId !== null) {
      const parent = yield* storage('readNode', () => sql.readNode(input.parentId as string))
      if (parent === null) {
        return yield* Effect.fail(
          new RequestValidationError({ message: 'parent node does not exist' }),
        )
      }
      if (parent.season !== input.season) {
        return yield* Effect.fail(
          new RequestValidationError({ message: 'parent node belongs to a different season' }),
        )
      }
      if (
        parent.surface.kind !== input.surface.kind ||
        parent.surface.allianceId !== input.surface.allianceId
      ) {
        return yield* Effect.fail(
          new RequestValidationError({ message: 'parent node belongs to a different surface' }),
        )
      }
      parentPath = parent.path
    }

    const node: NodeRecord = {
      id: uuidV7(),
      surface: input.surface,
      season: input.season,
      parentId: input.parentId,
      path: `${parentPath}/${segment}`,
      name: input.name,
      description: input.description ?? null,
      createdAt: millis(Date.now()),
    }
    const inserted = yield* Effect.tryPromise({
      try: () => sql.insertNode(node),
      catch: (cause): RequestValidationError | BackendStorageError =>
        cause instanceof NodePathConflictError ||
        cause instanceof InvalidNodeParentError ||
        cause instanceof NodePathTooLongError
          ? new RequestValidationError({ message: cause.message })
          : new BackendStorageError({ operation: 'insertNode', cause }),
    })
    return publicNode(inserted)
  })

export const listNodes = (
  season: number,
  surface: TemplateSurface,
): Effect.Effect<readonly ReturnType<typeof publicNode>[], BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const nodes = yield* storage('listNodes', () => sql.listNodes(season, surface))
    return nodes.map(publicNode)
  })

export const patchNode = (input: {
  readonly nodeId: string
  readonly name?: string
  readonly parentId?: string | null
}): Effect.Effect<ReturnType<typeof publicNode>, NodeError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const node = yield* storage('readNode', () => sql.readNode(input.nodeId))
    if (node === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const segment = input.name === undefined ? nodeSlug(node.name) : nodeSlug(input.name)
    const nextParentId = input.parentId === undefined ? node.parentId : input.parentId
    let parentPath = node.path.slice(0, node.path.lastIndexOf('/'))
    if (input.parentId !== undefined) {
      if (nextParentId === null) parentPath = ''
      else {
        const parent = yield* storage('readNode', () => sql.readNode(nextParentId))
        if (parent === null) {
          return yield* Effect.fail(
            new RequestValidationError({ message: 'parent node does not exist' }),
          )
        }
        parentPath = parent.path
      }
    }
    const path = `${parentPath}/${segment}`
    const changed = yield* Effect.tryPromise({
      try: async () => {
        if (input.parentId !== undefined) {
          return sql.moveNode(input.nodeId, nextParentId, path, {
            ...(input.name === undefined ? {} : { name: input.name }),
          })
        }
        if (input.name !== undefined) {
          return (await sql.renameNode(input.nodeId, input.name, segment)) !== null
        }
        return true
      },
      catch: (cause): RequestValidationError | ResourceConflictError | BackendStorageError => {
        if (cause instanceof InvalidNodeParentError || cause instanceof NodePathTooLongError) {
          return new RequestValidationError({ message: cause.message })
        }
        if (cause instanceof NodePathConflictError) {
          return new ResourceConflictError({ message: cause.message })
        }
        return new BackendStorageError({ operation: 'patchNode', cause })
      },
    })
    if (!changed) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const updated = yield* storage('readNode', () => sql.readNode(input.nodeId))
    if (updated === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    return publicNode(updated)
  })

export const countNodeSubtree = (
  nodeId: string,
): Effect.Effect<
  { readonly nodes: number; readonly templates: number },
  ResourceNotFoundError | BackendStorageError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* Effect.tryPromise({
      try: () => sql.countNodeSubtree(nodeId),
      catch: (cause): ResourceNotFoundError | BackendStorageError =>
        cause instanceof NodeNotFoundError
          ? new ResourceNotFoundError({ message: 'not found' })
          : new BackendStorageError({ operation: 'countNodeSubtree', cause }),
    })
  })

export const deleteNodeCascade = (
  nodeId: string,
  expected: NodeDeletion,
): Effect.Effect<
  NodeDeletion,
  ResourceNotFoundError | ResourceConflictError | BackendStorageError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node = yield* storage('readNode', () => sql.readNode(nodeId))
    if (node === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    const deleted = yield* Effect.tryPromise({
      try: () => sql.deleteNodeCascade(nodeId, expected),
      catch: (cause): ResourceNotFoundError | ResourceConflictError | BackendStorageError => {
        if (cause instanceof NodeNotFoundError) {
          return new ResourceNotFoundError({ message: 'not found' })
        }
        if (cause instanceof NodeSubtreeChangedError) {
          return new ResourceConflictError({ message: cause.message })
        }
        return new BackendStorageError({ operation: 'deleteNodeCascade', cause })
      },
    })
    if (deleted.templates > 0) {
      yield* Effect.promise(() => repairCommittedStatusProjection(statusReadModel, node.season))
    }
    return deleted
  })

export const deleteEmptyNode = (
  nodeId: string,
): Effect.Effect<
  void,
  ResourceNotFoundError | ResourceConflictError | BackendStorageError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const node = yield* storage('readNode', () => sql.readNode(nodeId))
    if (node === null) {
      return yield* Effect.fail(new ResourceNotFoundError({ message: 'not found' }))
    }
    yield* Effect.tryPromise({
      try: () => sql.deleteNode(nodeId),
      catch: (cause): ResourceConflictError | BackendStorageError =>
        cause instanceof NodeNotEmptyError
          ? new ResourceConflictError({ message: cause.message })
          : new BackendStorageError({ operation: 'deleteNode', cause }),
    })
  })
