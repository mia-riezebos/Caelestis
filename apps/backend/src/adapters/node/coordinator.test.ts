import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DurableScheduler } from '../../coordination/scheduler.js'
import { TelemetryCoordinator } from '../../coordination/telemetry.js'
import type { SqlStore } from '../../ports/index.js'
import { createChunkedStatusPersistence } from '../../status-coordinator.js'
import { MemorySqlStore } from '../memory/memory-sql-store.js'
import type { TransactionalSqlConnection } from '../sql-connection.js'
import { coordinatorDatabase } from './coordinator-database.js'
import { SqlCoordinatorStorage } from './coordinator-storage.js'
import { PostgresConnection } from './postgres-connection.js'
import { SqliteConnection } from './sqlite-connection.js'

type Harness = {
  connection: TransactionalSqlConnection
  reopen(): Promise<TransactionalSqlConnection>
  close(): Promise<void>
}
const adapters: { name: string; make(): Promise<Harness> }[] = [
  {
    name: 'SQLite',
    async make() {
      const directory = await mkdtemp(join(tmpdir(), 'caelestis-coordinator-'))
      let connection = new SqliteConnection(join(directory, 'db.sqlite'))
      return {
        connection,
        async reopen() {
          connection.close()
          connection = new SqliteConnection(join(directory, 'db.sqlite'))
          return connection
        },
        async close() {
          connection.close()
          await rm(directory, { recursive: true, force: true })
        },
      }
    },
  },
]
if (process.env.CAELESTIS_TEST_POSTGRES_URL)
  adapters.push({
    name: 'PostgreSQL',
    async make() {
      const schema = `coordinator_${crypto.randomUUID().replaceAll('-', '')}`
      const config = {
        connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
        options: `-c search_path=${schema}`,
      }
      let connection = new PostgresConnection(config)
      await connection.pool.query(`CREATE SCHEMA ${schema}`)
      return {
        connection,
        async reopen() {
          await connection.close()
          connection = new PostgresConnection(config)
          return connection
        },
        async close() {
          await connection.pool.query(`DROP SCHEMA ${schema} CASCADE`)
          await connection.close()
        },
      }
    },
  })

describe.each(adapters)('$name durable coordination', ({ make }) => {
  let harness: Harness
  let storage: SqlCoordinatorStorage
  beforeEach(async () => {
    harness = await make()
    const database = coordinatorDatabase(harness.connection)
    await SqlCoordinatorStorage.initialize(database)
    storage = new SqlCoordinatorStorage(database, 'test')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await harness?.close()
  })

  it('persists values and alarms across reconnect and rolls back failed state publication', async () => {
    await storage.transaction(async (transaction) => {
      await transaction.put('job', { cursor: 2 })
      await transaction.setAlarm(1)
    })
    await expect(
      storage.transaction(async (transaction) => {
        await transaction.put('job', { cursor: 3 })
        throw new Error('crash')
      }),
    ).rejects.toThrow('crash')
    storage = new SqlCoordinatorStorage(coordinatorDatabase(await harness.reopen()), 'test')
    expect(await storage.get('job')).toEqual({ cursor: 2 })
    expect(await storage.getAlarm()).toBe(1)
    expect(await storage.list({ prefix: 'jo' })).toEqual(new Map([['job', { cursor: 2 }]]))
  })

  it('retries interrupted jobs after reconnect and preserves a replacement wakeup', async () => {
    await storage.setAlarm(1)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new DurableScheduler(storage.database, async () => {
      throw new Error('interrupted')
    })
    await failing.tick()
    expect(await storage.getAlarm()).not.toBeNull()
    storage = new SqlCoordinatorStorage(coordinatorDatabase(await harness.reopen()), 'test')
    const successful = new DurableScheduler(storage.database, async () => {
      await storage.deleteAlarm()
      await storage.setAlarm(1)
    })
    await successful.tick(Date.now() + 5000)
    expect(await storage.getAlarm()).toBe(1)
    await new DurableScheduler(storage.database, async () => {}).tick()
    expect(await storage.getAlarm()).toBeNull()
  })

  it('recovers the published live revision and scoped projections after reconnect', async () => {
    const publicStatus = {
      templateId: 'public',
      correct: 1,
      wrong: 0,
      blank: 1,
      total: 2,
      colours: [],
      observedAt: millis(1000),
    }
    const privateStatus = { ...publicStatus, templateId: 'private' }
    const snapshot = {
      season: 0,
      revision: 42,
      reconciledAt: 1000,
      publicTemplates: [publicStatus],
      adminTemplates: [publicStatus, privateStatus],
    }
    await createChunkedStatusPersistence(storage, 0).save(snapshot)
    storage = new SqlCoordinatorStorage(coordinatorDatabase(await harness.reopen()), 'test')
    expect(await createChunkedStatusPersistence(storage, 0).load()).toEqual(snapshot)
  })

  it('recovers accepted counters and retries an ambiguous flush without doubling history', async () => {
    let now = millis(120000)
    const history: SqlStore = new MemorySqlStore()
    let counter = new TelemetryCoordinator(storage.database, storage, history, () => now)
    await counter.initialize()
    const delta = {
      templateId: 'template',
      occurredAt: seconds(120),
      placed: 3,
      correct: 2,
      repairs: 1,
    }
    await counter.record([delta], 'event')
    storage = new SqlCoordinatorStorage(coordinatorDatabase(await harness.reopen()), 'test')
    counter = new TelemetryCoordinator(storage.database, storage, history, () => now)
    await counter.initialize()
    await counter.record([delta], 'event')
    expect((await counter.readPending(['template']))[0]?.placed).toBe(3)
    now = millis(240000)
    const append = history.appendBuckets.bind(history)
    const appended = vi.spyOn(history, 'appendBuckets').mockImplementationOnce(async (buckets) => {
      await append(buckets)
      throw new Error('lost response')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await counter.alarm()
    expect(await counter.readFlushFailureCount()).toBe(1)
    storage = new SqlCoordinatorStorage(coordinatorDatabase(await harness.reopen()), 'test')
    counter = new TelemetryCoordinator(storage.database, storage, history, () => now)
    await counter.initialize()
    await counter.alarm()
    expect(await counter.readFlushFailureCount()).toBe(0)
    expect((await counter.readPending(['template']))[0]?.placed).toBe(0)
    expect(appended).toHaveBeenCalledTimes(2)
    expect(
      await history.readBuckets({
        templateIds: ['template'],
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(300),
      }),
    ).toEqual([expect.objectContaining({ placed: 3, correct: 2, repairs: 1 })])
  })
})
