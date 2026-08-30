import { Data } from 'effect'

/** A rejected SQL read that the HTTP edge must not expose to callers. */
export class SqlStoreReadError extends Data.TaggedError('SqlStoreReadError')<{
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

/** A non-telemetry dependency rejected an otherwise valid backend operation. */
export class BackendStorageError extends Data.TaggedError('BackendStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** Parsed input failed a migrated use case's domain validation. */
export class RequestValidationError extends Data.TaggedError('RequestValidationError')<{
  readonly message: string
}> {}

/** A migrated use case could not find the requested resource. */
export class ResourceNotFoundError extends Data.TaggedError('ResourceNotFoundError')<{
  readonly message: string
}> {}

/** A migrated write lost an optimistic concurrency race. */
export class ResourceConflictError extends Data.TaggedError('ResourceConflictError')<{
  readonly message: string
}> {}

/** A destructive write omitted the revision precondition required to make it safe. */
export class PreconditionRequiredError extends Data.TaggedError('PreconditionRequiredError')<{
  readonly message: string
}> {}

/** Authentication failed without revealing whether a credential exists or was revoked. */
export class UnauthorizedError extends Data.TaggedError('UnauthorizedError')<{
  readonly message: 'unauthorized'
}> {}

/** The authenticated caller does not hold the required scope. */
export class ForbiddenError extends Data.TaggedError('ForbiddenError')<{
  readonly message: 'forbidden'
}> {}

export type BackendHttpError =
  | SqlStoreReadError
  | TelemetryStorageError
  | TelemetryValidationError
  | BackendStorageError
  | RequestValidationError
  | ResourceNotFoundError
  | ResourceConflictError
  | PreconditionRequiredError
  | UnauthorizedError
  | ForbiddenError
