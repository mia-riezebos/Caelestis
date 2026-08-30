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

export type BackendHttpError = SqlStoreReadError | TelemetryStorageError | TelemetryValidationError
