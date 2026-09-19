import type { CoordinatorDatabase } from './database.js'

const RETRY_DELAY_MS = 1000
const POLL_INTERVAL_MS = 250
const MAX_CONCURRENT_JOBS = 8
const DEFAULT_CLAIM_TTL_MS = 30_000
type Alarm = { actor: string; due_at: number; generation: string }

/**
 * Milliseconds since the epoch on the database's clock. Leases are created, renewed, and expired
 * on this one timeline so a process with a skewed wall clock cannot steal an active claim.
 */
const databaseNow = (dialect: CoordinatorDatabase['dialect']): string =>
  dialect === 'postgres'
    ? '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT'
    : dialect === 'mariadb'
      ? 'FLOOR(UNIX_TIMESTAMP(NOW(3)) * 1000)'
      : "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

/**
 * At-least-once wakeups remain persisted until their handler succeeds or replaces the alarm.
 *
 * Each due row is claimed with a fenced, renewable lease before dispatch, so several processes
 * sharing one database run a job once. A crashed owner's claim expires; a stale owner can no
 * longer complete or retry a row that another owner has since claimed.
 */
export class DurableScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private running: Promise<void> = Promise.resolve()
  private readonly active = new Map<string, Promise<void>>()
  readonly owner: string
  private readonly claimTtlMs: number
  private readonly now: string

  constructor(
    private readonly database: CoordinatorDatabase,
    private readonly dispatch: (actor: string) => Promise<void>,
    options: { owner?: string; claimTtlMs?: number } = {},
  ) {
    this.owner = options.owner ?? crypto.randomUUID()
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
    this.now = databaseNow(database.dialect)
  }

  /** `now` decides which alarms are due; lease expiry always follows the database clock. */
  async tick(now = Date.now()): Promise<void> {
    await Promise.all(await this.scan(now))
  }

  private async scan(now = Date.now()): Promise<Promise<void>[]> {
    const alarms = await this.database.all<Alarm>(
      `SELECT actor, due_at, generation FROM runtime_alarms WHERE due_at <= ?1 AND (claimed_until IS NULL OR claimed_until <= ${this.now}) ORDER BY due_at, actor LIMIT 32`,
      now,
    )
    const started: Promise<void>[] = []
    for (const alarm of alarms) {
      if (this.active.size >= MAX_CONCURRENT_JOBS) break
      if (this.active.has(alarm.actor)) continue
      if (!(await this.claim(alarm))) continue
      const task = this.deliver(alarm)
        .catch((error: unknown) => console.error('Durable job storage failed', error))
        .finally(() => this.active.delete(alarm.actor))
      this.active.set(alarm.actor, task)
      started.push(task)
    }
    return started
  }

  /** Only an unclaimed or expired row can be taken, and only in the state the scan observed. */
  private async claim(alarm: Alarm): Promise<boolean> {
    const claimed = await this.database.run(
      `UPDATE runtime_alarms SET claimed_by = ?1, claimed_until = ${this.now} + ?2 WHERE actor = ?3 AND generation = ?4 AND due_at = ?5 AND (claimed_until IS NULL OR claimed_until <= ${this.now})`,
      this.owner,
      this.claimTtlMs,
      alarm.actor,
      alarm.generation,
      alarm.due_at,
    )
    return claimed.rowsWritten === 1
  }

  private async renew(actor: string): Promise<void> {
    const renewed = await this.database.run(
      `UPDATE runtime_alarms SET claimed_until = ${this.now} + ?1 WHERE actor = ?2 AND claimed_by = ?3`,
      this.claimTtlMs,
      actor,
      this.owner,
    )
    if (renewed.rowsWritten !== 1) console.warn(`Durable job claim lost: ${actor}`)
  }

  /** Clear this owner's claim when the handler replaced its alarm instead of completing it. */
  private release(actor: string): Promise<unknown> {
    return this.database.run(
      'UPDATE runtime_alarms SET claimed_by = NULL, claimed_until = NULL WHERE actor = ?1 AND claimed_by = ?2',
      actor,
      this.owner,
    )
  }

  private async deliver(alarm: Alarm): Promise<void> {
    const renewal = setInterval(
      () => {
        this.renew(alarm.actor).catch((error: unknown) =>
          console.error(`Durable job claim renewal failed: ${alarm.actor}`, error),
        )
      },
      Math.max(1, Math.floor(this.claimTtlMs / 3)),
    )
    renewal.unref?.()
    try {
      await this.dispatch(alarm.actor)
      clearInterval(renewal)
      await this.database.run(
        'DELETE FROM runtime_alarms WHERE actor = ?1 AND generation = ?2 AND due_at = ?3 AND claimed_by = ?4',
        alarm.actor,
        alarm.generation,
        alarm.due_at,
        this.owner,
      )
    } catch (error) {
      clearInterval(renewal)
      console.error(`Durable job failed: ${alarm.actor}`, error)
      await this.database.run(
        'UPDATE runtime_alarms SET due_at = ?1, claimed_by = NULL, claimed_until = NULL WHERE actor = ?2 AND generation = ?3 AND due_at = ?4 AND claimed_by = ?5',
        Date.now() + RETRY_DELAY_MS,
        alarm.actor,
        alarm.generation,
        alarm.due_at,
        this.owner,
      )
    } finally {
      clearInterval(renewal)
      await this.release(alarm.actor)
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const poll = () => {
      this.running = this.scan()
        .then(() => undefined)
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
    await Promise.all(this.active.values())
  }
}
