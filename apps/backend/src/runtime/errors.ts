import { Data } from 'effect'

/** A rejected SQL read that the HTTP edge must not expose to callers. */
export class SqlStoreReadError extends Data.TaggedError('SqlStoreReadError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** The reconstructible status projection could not read or repair its D1-backed snapshot. */
export class StatusReadModelError extends Data.TaggedError('StatusReadModelError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** A telemetry dependency rejected an otherwise valid operation. */
export class TelemetryStorageError extends Data.TaggedError('TelemetryStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** Telemetry input passed HTTP parsing but failed domain validation. */
export class TelemetryValidationError extends Data.TaggedError('TelemetryValidationError')<{
  readonly message: string
}> {}

/** Input or a domain precondition the caller can correct. */
export class RequestValidationError extends Data.TaggedError('RequestValidationError')<{
  readonly message: string
  readonly status?: 400 | 428
}> {}

/** The requested resource is absent without exposing a storage failure. */
export class ResourceNotFoundError extends Data.TaggedError('ResourceNotFoundError')<{
  readonly message: string
}> {}

/** A guarded write lost a race or conflicts with current state. */
export class ResourceConflictError extends Data.TaggedError('ResourceConflictError')<{
  readonly message: string
}> {}

/** A template, node, or blob dependency rejected an otherwise valid operation. */
export class BackendStorageError extends Data.TaggedError('BackendStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** Authentication failed without revealing whether a presented credential exists. */
export class AuthenticationError extends Data.TaggedError('AuthenticationError')<{
  readonly status: 401 | 403
  readonly message: 'unauthorized' | 'forbidden'
}> {}

export type BackendHttpError =
  | SqlStoreReadError
  | StatusReadModelError
  | TelemetryStorageError
  | TelemetryValidationError
  | RequestValidationError
  | ResourceNotFoundError
  | ResourceConflictError
  | BackendStorageError
  | AuthenticationError
