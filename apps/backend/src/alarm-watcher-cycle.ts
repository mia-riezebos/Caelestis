import { type Millis, seconds } from '@caelestis/shared'
import type { Ports } from './ports/index.js'
import { fetchAlarmFollowUps } from './telemetry/fetcher.js'

export const ALARM_RETRY_DELAY_MILLISECONDS = 60_000
export const ALARM_BATCH_DELAY_MILLISECONDS = 1_000

interface AlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}

type FollowUpRunner = typeof fetchAlarmFollowUps

/** Run one bounded durable probe cycle and retain ownership of all retries. */
export const runAlarmWatcherCycle = async (
  ports: Ports,
  storage: AlarmStorage,
  now: Millis,
  runFollowUps: FollowUpRunner = fetchAlarmFollowUps,
): Promise<void> => {
  try {
    const probes = await ports.sql.listDueAlarmProbes(now)
    const report = await runFollowUps(ports, probes, {
      now: seconds(Math.floor(now / 1_000)),
    })
    if (report.failed > 0) {
      await storage.setAlarm(now + ALARM_RETRY_DELAY_MILLISECONDS)
      return
    }
    const dueAt = await ports.sql.nextAlarmProbeAt()
    if (dueAt === null) {
      await storage.deleteAlarm()
      return
    }
    await storage.setAlarm(
      report.pending > 0 ? Math.max(dueAt, now + ALARM_BATCH_DELAY_MILLISECONDS) : dueAt,
    )
  } catch {
    // Cloudflare gives a throwing alarm only a bounded retry series. Keep the durable D1 probe and
    // own an indefinite, paced retry instead of stranding it until the next six-hour cron.
    await storage.setAlarm(now + ALARM_RETRY_DELAY_MILLISECONDS)
  }
}
