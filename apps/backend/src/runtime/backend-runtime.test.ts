import { millis } from '@caelestis/shared'
import { Context, Effect } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import {
  BlobStoreService,
  CounterStoreService,
  createBackendRuntime,
  makeBackendContext,
  SqlStoreService,
  StatusReadModelService,
} from './backend-runtime.js'
import {
  AuthenticationError,
  type BackendHttpError,
  BackendStorageError,
  RequestValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
  SqlStoreReadError,
  StatusReadModelError,
  TelemetryStorageError,
  TelemetryValidationError,
} from './errors.js'
import { runBackendHttp } from './hono.js'

const makeServices = () => {
  const sql = new MemorySqlStore()
  return {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(0)),
  }
}

describe('backend runtime', () => {
  it('runs programs from an explicit Context of narrow services', async () => {
    const services = makeServices()
    const runtime = createBackendRuntime(
      makeBackendContext(services.blobs, services.sql, services.counters),
    )

    expect(Context.get(runtime.context, BlobStoreService)).toBe(services.blobs)
    expect(Context.get(runtime.context, SqlStoreService)).toBe(services.sql)
    expect(Context.get(runtime.context, CounterStoreService)).toBe(services.counters)
    expect(Context.get(runtime.context, StatusReadModelService)).toBeDefined()

    const resolved = await runtime.run(
      Effect.gen(function* () {
        return {
          blobs: yield* BlobStoreService,
          sql: yield* SqlStoreService,
          counters: yield* CounterStoreService,
        }
      }),
    )
    expect(resolved).toEqual(services)
  })

  it('exposes the explicit Context as a Layer', async () => {
    const services = makeServices()
    const runtime = createBackendRuntime(
      makeBackendContext(services.blobs, services.sql, services.counters),
    )
    const program = Effect.gen(function* () {
      return yield* SqlStoreService
    })

    await expect(Effect.runPromise(Effect.provide(program, runtime.layer))).resolves.toBe(
      services.sql,
    )
  })
})

const storageCause = new Error('storage unavailable')
const edgeCases: readonly {
  readonly name: string
  readonly failure: BackendHttpError
  readonly status: number
  readonly body: string
  readonly logsCause?: boolean
}[] = [
  {
    name: 'SQL read failure',
    failure: new SqlStoreReadError({ operation: 'read', cause: storageCause }),
    status: 500,
    body: 'Internal Server Error',
    logsCause: true,
  },
  {
    name: 'status read-model failure',
    failure: new StatusReadModelError({ operation: 'reconcile', cause: storageCause }),
    status: 500,
    body: 'Internal Server Error',
    logsCause: true,
  },
  {
    name: 'telemetry storage failure',
    failure: new TelemetryStorageError({ operation: 'record', cause: storageCause }),
    status: 500,
    body: 'Internal Server Error',
    logsCause: true,
  },
  {
    name: 'backend storage failure',
    failure: new BackendStorageError({ operation: 'write', cause: storageCause }),
    status: 500,
    body: 'Internal Server Error',
    logsCause: true,
  },
  {
    name: 'telemetry validation failure',
    failure: new TelemetryValidationError({ message: 'invalid telemetry' }),
    status: 400,
    body: '{"error":"invalid telemetry"}',
  },
  {
    name: 'request validation failure',
    failure: new RequestValidationError({ message: 'invalid request' }),
    status: 400,
    body: '{"error":"invalid request"}',
  },
  {
    name: 'request precondition failure',
    failure: new RequestValidationError({ message: 'precondition required', status: 428 }),
    status: 428,
    body: '{"error":"precondition required"}',
  },
  {
    name: 'missing resource',
    failure: new ResourceNotFoundError({ message: 'missing' }),
    status: 404,
    body: '{"error":"missing"}',
  },
  {
    name: 'resource conflict',
    failure: new ResourceConflictError({ message: 'conflict' }),
    status: 409,
    body: '{"error":"conflict"}',
  },
  {
    name: 'missing authentication',
    failure: new AuthenticationError({ status: 401, message: 'unauthorized' }),
    status: 401,
    body: '{"error":"unauthorized"}',
  },
  {
    name: 'insufficient scope',
    failure: new AuthenticationError({ status: 403, message: 'forbidden' }),
    status: 403,
    body: '{"error":"forbidden"}',
  },
]

describe('typed backend HTTP failures', () => {
  it.each(edgeCases)('maps $name exhaustively', async ({ failure, status, body, logsCause }) => {
    const services = makeServices()
    const runtime = createBackendRuntime(
      makeBackendContext(services.blobs, services.sql, services.counters),
    )
    const app = new Hono()
    app.get('/', (context) =>
      runBackendHttp(context, runtime, Effect.fail(failure), () => context.text('unreachable')),
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.request('/')

    expect(response.status).toBe(status)
    expect(await response.text()).toBe(body)
    if (logsCause === true) expect(consoleError).toHaveBeenCalledWith(storageCause)
    else expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
