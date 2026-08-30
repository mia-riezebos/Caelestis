import { type Millis, millis, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import { type BlobStoreService, SqlStoreService } from './runtime/backend-runtime.js'
import {
  ALARM_FOLLOW_UP_RETRY_MILLISECONDS,
  type AlarmFollowUpReport,
  type FetchAlarmFollowUpsOptions,
  fetchAlarmFollowUps,
} from './telemetry/fetcher.js'

export const ALARM_RETRY_DELAY_MILLISECONDS = ALARM_FOLLOW_UP_RETRY_MILLISECONDS
export const ALARM_BATCH_DELAY_MILLISECONDS = 1_000

interface AlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>
}

type FollowUpRunner = (
  probes: Parameters<typeof fetchAlarmFollowUps>[0],
  options?: FetchAlarmFollowUpsOptions,
) => Effect.Effect<AlarmFollowUpReport, unknown, BlobStoreService | SqlStoreService>

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })

/** Run one bounded durable probe cycle and retain ownership of all retries. */
export const runAlarmWatcherCycle = (
  storage: AlarmStorage,
  now: Millis,
  runFollowUps: FollowUpRunner = fetchAlarmFollowUps,
  clock: () => Millis = () => millis(Date.now()),
): Effect.Effect<void, unknown, BlobStoreService | SqlStoreService> => {
  const cycle = Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const probes = yield* attempt(() => sql.listDueAlarmProbes(now))
    const report = yield* runFollowUps(probes, {
      now: seconds(Math.floor(now / 1_000)),
    })
    const decidedAt = clock()
    if (report.failed > 0) {
      yield* attempt(() => storage.setAlarm(decidedAt + ALARM_RETRY_DELAY_MILLISECONDS))
      return
    }
    const dueAt = yield* attempt(() => sql.nextAlarmProbeAt())
    if (dueAt === null) {
      // A concurrent schedule may have installed a replacement wakeup after this D1 read. The
      // currently firing alarm is consumed, so leaving storage untouched is race-safe.
      return
    }
    yield* attempt(() =>
      storage.setAlarm(
        report.pending > 0 ? Math.max(dueAt, decidedAt + ALARM_BATCH_DELAY_MILLISECONDS) : dueAt,
      ),
    )
  })

  return Effect.catch(cycle, () =>
    // Cloudflare gives a throwing alarm only a bounded retry series. Keep the durable D1 probe and
    // own a paced retry. If even that write fails, reject so the platform's native retry remains.
    attempt(() => storage.setAlarm(clock() + ALARM_RETRY_DELAY_MILLISECONDS)),
  )
}
