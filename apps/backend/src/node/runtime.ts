import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { millis, uuidV7 } from '@caelestis/shared'
import type { ObjectStorage } from '@caelestis/storage'
import { CoordinatedStatusReadModel } from '../adapters/coordinated-status-read-model.js'
import { coordinatorDatabase } from '../adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../adapters/node/coordinator-storage.js'
import { MariaConnection } from '../adapters/node/mariadb-connection.js'
import { PostgresConnection } from '../adapters/node/postgres-connection.js'
import { SqliteConnection } from '../adapters/node/sqlite-connection.js'
import { claimSqliteOwnership } from '../adapters/node/sqlite-ownership.js'
import { ObjectBlobStore } from '../adapters/object-blob-store.js'
import { RelationalSqlStore } from '../adapters/relational-sql-store.js'
import { runAlarmWatcherCycle } from '../alarm-watcher-cycle.js'
import { createApp } from '../app.js'
import { hashToken, mintToken } from '../auth/tokens.js'
import { EralyonArchive } from '../backfill/eralyon.js'
import { TemplateBackfill } from '../backfill/import.js'
import { backfillReply } from '../backfill/port.js'
import { DurableScheduler } from '../coordination/scheduler.js'
import { TelemetryCoordinator } from '../coordination/telemetry.js'
import { createBackendRuntime, makeBackendContext } from '../runtime/backend-runtime.js'
import { StatusCoordinator } from '../status-coordinator.js'
import { fetchCanvasTiles } from '../telemetry/fetcher.js'
import { runTileBlobGc } from '../telemetry/tile-blobs.js'
import type { NodeConfig } from './config.js'
import { NodeLiveHost } from './live.js'

const MIRROR_INTERVAL_MS = 6 * 60 * 60 * 1000
const SOCIAL_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Open one owned runtime. HTTP starts only after migrations and durable state recover. */
export const openNodeRuntime = async (
  config: NodeConfig,
  objects: ObjectStorage,
  options: { onOwnershipLost: (error: Error) => void; refreshSocial?: () => Promise<void> },
) => {
  let releaseSqlite: (() => void) | undefined
  if (config.adapter === 'sqlite') {
    await mkdir(dirname(config.databaseFile), { recursive: true, mode: 0o700 })
    releaseSqlite = claimSqliteOwnership(config.databaseFile)
  }
  let connection: PostgresConnection | SqliteConnection | MariaConnection
  try {
    connection =
      config.adapter === 'mariadb'
        ? new MariaConnection(config.maria)
        : config.adapter === 'postgres'
          ? new PostgresConnection(config.pg)
          : new SqliteConnection(config.databaseFile)
  } catch (error) {
    releaseSqlite?.()
    throw error
  }
  try {
    if (connection instanceof PostgresConnection || connection instanceof MariaConnection)
      await connection.claimOwnership(options.onOwnershipLost)
    await connection.migrate(
      join(
        import.meta.dirname,
        connection instanceof MariaConnection
          ? '../../migrations-mariadb'
          : connection instanceof PostgresConnection
            ? '../../migrations-postgres'
            : '../../migrations',
      ),
    )
    const database = coordinatorDatabase(connection)
    await SqlCoordinatorStorage.initialize(database)
    const state = (actor: string) => new SqlCoordinatorStorage(database, actor)
    const serverState = state('server')
    const serverId = config.serverId ?? (await serverState.get<string>('id')) ?? uuidV7()
    await serverState.put('id', serverId)
    const sql = new RelationalSqlStore(connection)
    const blobs = new ObjectBlobStore(objects)
    const counterState = state('telemetry')
    const counters = new TelemetryCoordinator(database, counterState, sql)
    await counters.initialize()
    const storedReadToken = await serverState.get<string>('frontend-token')
    let readToken = config.readToken ?? storedReadToken
    if (
      !storedReadToken &&
      (!readToken || !(await sql.readAccessToken(await hashToken(readToken))))
    ) {
      readToken ??= mintToken()
      const tokenHash = await hashToken(readToken)
      const generated = readToken
      await connection.transaction(async (transaction) => {
        await new RelationalSqlStore(transaction).insertAccessToken({
          tokenHash,
          label: 'Built-in frontend',
          scope: 'read',
          createdWithToken: tokenHash,
          createdAt: millis(Date.now()),
        })
        await transaction
          .prepare('INSERT INTO runtime_values (actor, key, value) VALUES (?, ?, ?)')
          .bind('server', 'frontend-token', JSON.stringify(generated))
          .run()
      })
    }
    if (!readToken) throw new Error('Missing frontend read token')
    const token = await sql.readAccessToken(await hashToken(readToken))
    if (token?.scope !== 'read')
      throw new Error(
        'CAELESTIS_READ_TOKEN must identify an active read-only token; the stored frontend token may have been revoked',
      )
    if (!storedReadToken) await serverState.put('frontend-token', readToken)
    const alarmState = state('alarms')
    const scheduleAlarms = async () => {
      const due = await sql.nextAlarmProbeAt()
      if (due !== null) await alarmState.setAlarm(due)
    }
    const seasons = new Map<
      number,
      {
        coordinator: StatusCoordinator<ReturnType<NodeLiveHost['connect']>['client']>
        host: NodeLiveHost
      }
    >()
    const status = new CoordinatedStatusReadModel((season) => {
      const existing = seasons.get(season)
      if (existing) return existing.coordinator
      const host: NodeLiveHost = new NodeLiveHost(state(`season:${season}`), () => coordinator)
      const coordinator = new StatusCoordinator(
        host,
        sql,
        blobs,
        () => counters,
        {
          id: serverId,
          name: config.serverName,
          auth: config.openAccess ? 'none' : 'access_token',
          ...(config.serverDescription === undefined
            ? {}
            : { description: config.serverDescription }),
        },
        scheduleAlarms,
      )
      seasons.set(season, { coordinator, host })
      return coordinator
    }, scheduleAlarms)
    const stores = { sql, blobs, counters, statusReadModel: status }
    const context = makeBackendContext(blobs, sql, counters, status)
    const backendRuntime = createBackendRuntime(context)
    const imports = new Map<
      string,
      { importer: TemplateBackfill; exclusive<T>(operation: () => Promise<T>): Promise<T> }
    >()
    const importer = (id: string) => {
      const existing = imports.get(id)
      if (existing) return existing
      let tail: Promise<unknown> = Promise.resolve()
      const created = {
        importer: new TemplateBackfill(state(`backfill:${id}`), sql, blobs, new EralyonArchive()),
        exclusive<T>(operation: () => Promise<T>): Promise<T> {
          const running = tail.then(operation, operation)
          tail = running.then(
            () => undefined,
            () => undefined,
          )
          return running
        },
      }
      imports.set(id, created)
      return created
    }
    const app = createApp(context, {
      bootstrapAdminToken: config.adminToken,
      currentSeason: config.season,
      openAccess: config.openAccess,
      serverId,
      serverName: config.serverName,
      serverDescription: config.serverDescription,
      connectStatusLive: (request, connection) => status.connectLive(request, connection),
      backfillClients: (id) => {
        const held = importer(id)
        return {
          preview: (template) => backfillReply(() => held.importer.preview(template)),
          job: () => backfillReply(() => held.importer.job()),
          history: (version, tile) => backfillReply(() => held.importer.history(version, tile)),
          start: (template, version, snapshot) =>
            held.exclusive(() =>
              backfillReply(() => held.importer.start(template, version, snapshot)),
            ),
          cancel: () => held.exclusive(() => backfillReply(() => held.importer.cancel())),
        }
      },
    })
    const scheduler = new DurableScheduler(database, async (actor) => {
      if (actor === 'telemetry') return counters.alarm()
      if (actor === 'alarms')
        return runAlarmWatcherCycle(
          backendRuntime,
          { setAlarm: (time) => alarmState.setAlarm(time instanceof Date ? time.getTime() : time) },
          millis(Date.now()),
        )
      if (actor.startsWith('backfill:')) {
        const held = importer(actor.slice('backfill:'.length))
        return held.exclusive(() => held.importer.step())
      }
      if (actor === 'mirror') {
        try {
          await fetchCanvasTiles(stores, { season: config.season })
        } finally {
          await scheduleAlarms()
        }
        await state(actor).setAlarm(Date.now() + MIRROR_INTERVAL_MS)
        return
      }
      if (actor === 'gc') {
        await runTileBlobGc(stores, { mode: config.tileGc })
        await state(actor).setAlarm(Date.now() + MIRROR_INTERVAL_MS)
        return
      }
      if (actor === 'social' && options.refreshSocial) {
        await options.refreshSocial()
        await state(actor).setAlarm(Date.now() + SOCIAL_INTERVAL_MS)
        return
      }
      throw new Error(`Unknown durable job: ${actor}`)
    })
    await scheduleAlarms()
    for (const [actor, interval] of [
      ['mirror', MIRROR_INTERVAL_MS],
      ['gc', MIRROR_INTERVAL_MS],
      ...(options.refreshSocial ? [['social', SOCIAL_INTERVAL_MS] as const] : []),
    ] as const) {
      const job = state(actor)
      if ((await job.getAlarm()) === null) await job.setAlarm(Date.now() + interval)
    }
    let closed = false
    return {
      app,
      sql,
      counters,
      scheduler,
      objects,
      readToken,
      serverId,
      connection,
      async close() {
        if (closed) return
        closed = true
        await scheduler.stop()
        for (const { host } of seasons.values()) await host.close()
        await connection.close()
        releaseSqlite?.()
      },
    }
  } catch (error) {
    await connection.close()
    releaseSqlite?.()
    throw error
  }
}
