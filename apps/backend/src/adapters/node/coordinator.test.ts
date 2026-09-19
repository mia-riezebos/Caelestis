import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DurableScheduler } from '../../coordination/scheduler.js'
import { TelemetryCoordinator } from '../../coordination/telemetry.js'
import { sqliteConnection } from '../../node/database.js'
import type { SqlStore } from '../../ports/index.js'
import { createChunkedStatusPersistence } from '../../status-coordinator.js'
import { MemorySqlStore } from '../memory/memory-sql-store.js'
import type { TransactionalSqlConnection } from '../sql-connection.js'
import { coordinatorDatabase } from './coordinator-database.js'
import { SqlCoordinatorStorage } from './coordinator-storage.js'
import { mariaTestDatabase } from './mariadb.test-helper.js'
import { PostgresConnection } from './postgres-connection.js'

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
      let connection = sqliteConnection(join(directory, 'db.sqlite'))
      return {
        connection,
        async reopen() {
          connection.close()
          connection = sqliteConnection(join(directory, 'db.sqlite'))
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

if (process.env.CAELESTIS_TEST_MARIADB_URL)
  adapters.push({ name: 'MariaDB', make: mariaTestDatabase })

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

  it('refuses to start against a newer coordinator data format', async () => {
    const database = coordinatorDatabase(harness.connection)
    await database.run('UPDATE runtime_schema SET version = 3 WHERE id = 1')
    await expect(SqlCoordinatorStorage.initialize(database)).rejects.toThrow(
      'Unsupported coordinator schema version: 3',
    )
  })

  it('migrates a version 1 alarm table to fenced claims in place', async () => {
    const database = coordinatorDatabase(harness.connection)
    await database.run('DROP TABLE runtime_alarms')
    await database.run(
      'CREATE TABLE runtime_alarms (actor TEXT PRIMARY KEY, due_at BIGINT NOT NULL, generation TEXT NOT NULL)',
    )
    await database.run(
      "INSERT INTO runtime_alarms (actor, due_at, generation) VALUES ('legacy', 1, 'g1')",
    )
    await database.run('UPDATE runtime_schema SET version = 1 WHERE id = 1')
    await SqlCoordinatorStorage.initialize(database)
    await SqlCoordinatorStorage.initialize(database)
    expect(await database.one<{ version: number }>('SELECT version FROM runtime_schema')).toEqual({
      version: 2,
    })
    const delivered: string[] = []
    await new DurableScheduler(database, async (actor) => {
      delivered.push(actor)
    }).tick()
    expect(delivered).toEqual(['legacy'])
    expect(await database.all('SELECT actor FROM runtime_alarms')).toEqual([])
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

  it('delivers other actors while a slow job remains in progress', async () => {
    let started: () => void = () => {}
    let resume: () => void = () => {}
    let finished: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const delivered = new Promise<void>((resolve) => {
      finished = resolve
    })
    const scheduler = new DurableScheduler(storage.database, async (actor) => {
      if (actor === 'test') {
        started()
        await paused
      } else finished()
    })
    await storage.setAlarm(1)
    scheduler.start()
    try {
      await entered
      await new SqlCoordinatorStorage(storage.database, 'other').setAlarm(1)
      await delivered
    } finally {
      resume()
      await scheduler.stop()
    }
  })

  it('delivers a due job once when two schedulers share the database', async () => {
    const delivered: string[] = []
    const dispatch = (name: string) => async (actor: string) => {
      delivered.push(`${name}:${actor}`)
      await delay(20)
    }
    await storage.setAlarm(1)
    await new SqlCoordinatorStorage(storage.database, 'other').setAlarm(1)
    const first = new DurableScheduler(storage.database, dispatch('a'))
    const second = new DurableScheduler(storage.database, dispatch('b'))
    await Promise.all([first.tick(), second.tick()])
    expect(delivered.map((entry) => entry.slice(2)).sort()).toEqual(['other', 'test'])
    expect(await storage.getAlarm()).toBeNull()
    expect(await new DurableScheduler(storage.database, dispatch('c')).tick()).toBeUndefined()
    expect(delivered).toHaveLength(2)
  })

  it('lets another owner take a claim its owner stopped renewing and fences the stale owner out', async () => {
    let releaseStale: () => void = () => {}
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    const runs: string[] = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The stale owner loses its database connection while its handler is still running, so its
    // renewals fail and the claim expires on the database clock.
    let partitioned = false
    const partitionable: typeof storage.database = {
      ...storage.database,
      run: (query, ...values) => {
        if (partitioned) return Promise.reject(new Error('connection lost'))
        return storage.database.run(query, ...values)
      },
    }
    const stale = new DurableScheduler(
      partitionable,
      async () => {
        runs.push('stale')
        partitioned = true
        await staleBlocked
        throw new Error('stale owner failed late')
      },
      { owner: 'stale', claimTtlMs: 400 },
    )
    const fresh = new DurableScheduler(
      storage.database,
      async () => {
        runs.push('fresh')
      },
      { owner: 'fresh' },
    )
    await storage.setAlarm(1)
    const staleTick = stale.tick()
    await vi.waitFor(() => expect(runs).toEqual(['stale']))
    expect(
      await storage.database.all<{ claimed_by: string }>(
        "SELECT claimed_by FROM runtime_alarms WHERE actor = 'test'",
      ),
    ).toEqual([{ claimed_by: 'stale' }])
    await fresh.tick()
    expect(runs).toEqual(['stale'])
    await vi.waitFor(
      async () => {
        await fresh.tick()
        expect(runs).toEqual(['stale', 'fresh'])
      },
      { timeout: 3000, interval: 100 },
    )
    expect(await storage.getAlarm()).toBeNull()
    await storage.setAlarm(7)
    partitioned = false
    releaseStale()
    await staleTick
    expect(await storage.getAlarm()).toBe(7)
    expect(
      await storage.database.all<{ claimed_by: string | null }>(
        "SELECT claimed_by FROM runtime_alarms WHERE actor = 'test'",
      ),
    ).toEqual([{ claimed_by: null }])
  })

  it('renews its claim while a long job runs, even against a rival with a fast clock', async () => {
    let finish: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const runs: string[] = []
    const long = new DurableScheduler(
      storage.database,
      async () => {
        runs.push('long')
        await blocked
      },
      // Renewals run every 200 ms; the rival keeps probing well past the initial 600 ms lease.
      { owner: 'long', claimTtlMs: 600 },
    )
    const rival = new DurableScheduler(
      storage.database,
      async () => {
        runs.push('rival')
      },
      { owner: 'rival' },
    )
    await storage.setAlarm(1)
    const longTick = long.tick()
    await vi.waitFor(() => expect(runs).toEqual(['long']))
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await delay(150)
      // A rival whose wall clock runs a minute ahead still sees the lease as live.
      await rival.tick(Date.now() + 60_000)
    }
    expect(runs).toEqual(['long'])
    finish()
    await longTick
    expect(await storage.getAlarm()).toBeNull()
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

  it('does not let an older empty read erase a concurrently accepted counter wakeup', async () => {
    const counter = new TelemetryCoordinator(storage.database, storage, new MemorySqlStore(), () =>
      millis(120000),
    )
    await counter.initialize()
    let signalEntered: () => void = () => {}
    let resume: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const remove = storage.deleteAlarm.bind(storage)
    vi.spyOn(storage, 'deleteAlarm').mockImplementationOnce(async () => {
      signalEntered()
      await paused
      await remove()
    })
    const read = counter.readPending([])
    await entered
    const record = counter.record(
      [{ templateId: 'template', occurredAt: seconds(120), placed: 1, correct: 1, repairs: 0 }],
      'concurrent-event',
    )
    try {
      await vi.waitFor(async () => {
        const row = await storage.database.one<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_counters',
        )
        expect(row.count).toBe(1)
      })
      // Give the accepted record's planner a turn while the older deletion stays paused.
      await delay(50)
    } finally {
      resume()
      await Promise.all([read, record])
    }
    expect(await storage.getAlarm()).not.toBeNull()
  })
})
