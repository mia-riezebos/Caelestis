import { Effect } from 'effect'
import type { Context } from 'hono'
import type { BackendRuntime, BackendServices } from './backend-runtime.js'
import type { BackendHttpError } from './errors.js'

const mapBackendHttpError = (context: Context, error: BackendHttpError): Response => {
  switch (error._tag) {
    case 'SqlStoreReadError':
      // Hono's default error handler logged the rejected store call before returning this response.
      // Keep that signal while the failure moves into Effect's typed channel.
      console.error(error.cause)
      return context.text('Internal Server Error', 500)
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
