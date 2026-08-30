import { type Millis, millis, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import {
  type BackendRuntime,
  BlobStoreService,
  CounterStoreService,
  SqlStoreService,
} from './runtime/backend-runtime.js'
import {
  ALARM_FOLLOW_UP_RETRY_MILLISECONDS,
  type FetcherStores,
  fetchAlarmFollowUps,
} from './telemetry/fetcher.js'

export const ALARM_RETRY_DELAY_MILLISECONDS = ALARM_FOLLOW_UP_RETRY_MILLISECONDS
export const ALARM_BATCH_DELAY_MILLISECONDS = 1_000

interface AlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>
}

type FollowUpRunner = (
  stores: FetcherStores,
  probes: Parameters<typeof fetchAlarmFollowUps>[1],
  options: Parameters<typeof fetchAlarmFollowUps>[2],
) => ReturnType<typeof fetchAlarmFollowUps>

/** Run one bounded durable probe cycle and retain ownership of all retries. */
export const runAlarmWatcherCycle = async (
  runtime: BackendRuntime,
  storage: AlarmStorage,
  now: Millis,
  runFollowUps: FollowUpRunner = fetchAlarmFollowUps,
  clock: () => Millis = () => millis(Date.now()),
): Promise<void> => {
  await runtime.run(
    Effect.gen(function* () {
      const blobs = yield* BlobStoreService
      const counters = yield* CounterStoreService
      const sql = yield* SqlStoreService
      yield* Effect.promise(async () => {
        try {
          const probes = await sql.listDueAlarmProbes(now)
          const report = await runFollowUps({ blobs, counters, sql }, probes, {
            now: seconds(Math.floor(now / 1_000)),
          })
          const decidedAt = clock()
          if (report.failed > 0) {
            await storage.setAlarm(decidedAt + ALARM_RETRY_DELAY_MILLISECONDS)
            return
          }
          const dueAt = await sql.nextAlarmProbeAt()
          if (dueAt === null) {
            // A concurrent schedule may have installed a replacement wakeup after this D1 read. The
            // currently firing alarm is already consumed, so leaving storage untouched is race-safe.
            return
          }
          await storage.setAlarm(
            report.pending > 0
              ? Math.max(dueAt, decidedAt + ALARM_BATCH_DELAY_MILLISECONDS)
              : dueAt,
          )
        } catch {
          // Cloudflare gives a throwing alarm only a bounded retry series. Keep the durable D1 probe
          // and own an indefinite, paced retry instead of stranding it until the next six-hour cron.
          await storage.setAlarm(clock() + ALARM_RETRY_DELAY_MILLISECONDS)
        }
      })
    }),
  )
}
