import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from './adapters/memory/memory-blob-store.js'
import { ALARM_RETRY_DELAY_MILLISECONDS, runAlarmWatcherCycle } from './alarm-watcher-cycle.js'
import type { SqlStore } from './ports/index.js'
import { BlobStoreService, SqlStoreService } from './runtime/backend-runtime.js'

const run = <A, E>(
  sql: SqlStore,
  effect: Effect.Effect<A, E, BlobStoreService | SqlStoreService>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(BlobStoreService, new MemoryBlobStore()),
      Effect.provideService(SqlStoreService, sql),
    ),
  )

describe('alarm watcher', () => {
  it('owns an explicit retry when durable probe reads fail', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const sql = {
      listDueAlarmProbes: vi.fn(async () => Promise.reject(new Error('D1 unavailable'))),
    } as unknown as SqlStore

    await expect(
      run(
        sql,
        runAlarmWatcherCycle({ setAlarm }, millis(100_000), undefined, () => millis(100_000)),
      ),
    ).resolves.toBeUndefined()

    expect(setAlarm).toHaveBeenCalledWith(100_000 + ALARM_RETRY_DELAY_MILLISECONDS)
  })

  it('preserves the platform retry when fallback scheduling also fails', async () => {
    const setAlarm = vi.fn(async () => Promise.reject(new Error('alarm storage unavailable')))
    const sql = {
      listDueAlarmProbes: vi.fn(async () => Promise.reject(new Error('D1 unavailable'))),
    } as unknown as SqlStore

    await expect(
      run(
        sql,
        runAlarmWatcherCycle({ setAlarm }, millis(100_000), undefined, () => millis(100_000)),
      ),
    ).rejects.toThrow(/alarm storage unavailable/)

    expect(setAlarm).toHaveBeenCalledWith(100_000 + ALARM_RETRY_DELAY_MILLISECONDS)
  })

  it('continues a bounded multi-batch probe without a hot loop', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const sql = {
      listDueAlarmProbes: vi.fn(async () => []),
      nextAlarmProbeAt: vi.fn(async () => millis(90_000)),
    } as unknown as SqlStore

    await run(
      sql,
      runAlarmWatcherCycle(
        { setAlarm },
        millis(100_000),
        () => Effect.succeed({ evaluated: 0, failed: 0, pending: 1 }),
        () => millis(100_000),
      ),
    )

    expect(setAlarm).toHaveBeenCalledWith(101_000)
  })

  it('measures retry delay from the end of a slow follow-up cycle', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const sql = {
      listDueAlarmProbes: vi.fn(async () => []),
    } as unknown as SqlStore

    await run(
      sql,
      runAlarmWatcherCycle(
        { setAlarm },
        millis(100_000),
        () => Effect.succeed({ evaluated: 0, failed: 1, pending: 1 }),
        () => millis(300_000),
      ),
    )

    expect(setAlarm).toHaveBeenCalledWith(300_000 + ALARM_RETRY_DELAY_MILLISECONDS)
  })

  it('does not delete a replacement wakeup after an empty reconciliation', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const deleteAlarm = vi.fn(async () => undefined)
    const storage = { setAlarm, deleteAlarm }
    const sql = {
      listDueAlarmProbes: vi.fn(async () => []),
      nextAlarmProbeAt: vi.fn(async () => null),
    } as unknown as SqlStore

    await run(
      sql,
      runAlarmWatcherCycle(
        storage,
        millis(100_000),
        () => Effect.succeed({ evaluated: 0, failed: 0, pending: 0 }),
        () => millis(100_000),
      ),
    )

    expect(setAlarm).not.toHaveBeenCalled()
    expect(deleteAlarm).not.toHaveBeenCalled()
  })
})
