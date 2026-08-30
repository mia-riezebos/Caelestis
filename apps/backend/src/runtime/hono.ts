import { Effect } from 'effect'
import type { Context } from 'hono'
import type { BackendRuntime, BackendServices } from './backend-runtime.js'
import type { BackendHttpError } from './errors.js'

const mapBackendHttpError = (context: Context, error: BackendHttpError): Response => {
  switch (error._tag) {
    case 'SqlStoreReadError':
    case 'TelemetryStorageError':
    case 'BackendStorageError':
      // Hono's default error handler logged the rejected store call before returning this response.
      // Keep that signal while the failure moves into Effect's typed channel.
      console.error(error.cause)
      return context.text('Internal Server Error', 500)
    case 'TelemetryValidationError':
      return context.json({ error: error.message }, 400)
    case 'RequestValidationError':
      return context.json({ error: error.message }, error.status ?? 400)
    case 'ResourceNotFoundError':
      return context.json({ error: error.message }, 404)
    case 'ResourceConflictError':
      return context.json({ error: error.message }, 409)
  }
}

/** Run one Effect use case at the Hono boundary while leaving defects to Hono's error handler. */
export const runBackendHttp = <A, E extends BackendHttpError>(
  context: Context,
  runtime: BackendRuntime,
  effect: Effect.Effect<A, E, BackendServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> =>
  runtime.runHandled(Effect.map(effect, onSuccess), (error) => mapBackendHttpError(context, error))
