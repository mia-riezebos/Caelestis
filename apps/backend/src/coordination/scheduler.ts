import type { CoordinatorDatabase } from './database.js'

const RETRY_DELAY_MS = 1000
const POLL_INTERVAL_MS = 250
type Alarm = { actor: string; due_at: number; generation: string }

/** At-least-once wakeups remain persisted until their handler succeeds or replaces the alarm. */
export class DurableScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private running: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: CoordinatorDatabase,
    private readonly dispatch: (actor: string) => Promise<void>,
  ) {}

  async tick(now = Date.now()): Promise<void> {
    const alarms = await this.database.all<Alarm>(
      'SELECT actor, due_at, generation FROM runtime_alarms WHERE due_at <= ?1 ORDER BY due_at, actor LIMIT 32',
      now,
    )
    for (const alarm of alarms) {
      try {
        await this.dispatch(alarm.actor)
        await this.database.run(
          'DELETE FROM runtime_alarms WHERE actor = ?1 AND generation = ?2 AND due_at = ?3',
          alarm.actor,
          alarm.generation,
          alarm.due_at,
        )
      } catch (error) {
        console.error(`Durable job failed: ${alarm.actor}`, error)
        await this.database.run(
          'UPDATE runtime_alarms SET due_at = ?1 WHERE actor = ?2 AND generation = ?3 AND due_at = ?4',
          Date.now() + RETRY_DELAY_MS,
          alarm.actor,
          alarm.generation,
          alarm.due_at,
        )
      }
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const poll = () => {
      this.running = this.tick()
        .catch((error: unknown) => console.error('Durable scheduler failed', error))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(poll, POLL_INTERVAL_MS)
        })
    }
    poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
  }
}
