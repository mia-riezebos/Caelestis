import { Data } from 'effect'

/** A rejected SQL read that the HTTP edge must not expose to callers. */
export class SqlStoreReadError extends Data.TaggedError('SqlStoreReadError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

export type BackendHttpError = SqlStoreReadError
