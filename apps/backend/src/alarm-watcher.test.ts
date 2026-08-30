import { millis } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { ALARM_RETRY_DELAY_MILLISECONDS, runAlarmWatcherCycle } from './alarm-watcher-cycle.js'
import type { Ports } from './ports/index.js'

describe('alarm watcher', () => {
  it('owns an explicit retry when durable probe reads fail', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const ports = {
      sql: { listDueAlarmProbes: vi.fn(async () => Promise.reject(new Error('D1 unavailable'))) },
    } as unknown as Ports

    await expect(
      runAlarmWatcherCycle(ports, { setAlarm }, millis(100_000), undefined, () => millis(100_000)),
    ).resolves.toBeUndefined()

    expect(setAlarm).toHaveBeenCalledWith(100_000 + ALARM_RETRY_DELAY_MILLISECONDS)
  })

  it('continues a bounded multi-batch probe without a hot loop', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const ports = {
      sql: {
        listDueAlarmProbes: vi.fn(async () => []),
        nextAlarmProbeAt: vi.fn(async () => millis(90_000)),
      },
    } as unknown as Ports

    await runAlarmWatcherCycle(
      ports,
      { setAlarm },
      millis(100_000),
      async () => ({ evaluated: 0, failed: 0, pending: 1 }),
      () => millis(100_000),
    )

    expect(setAlarm).toHaveBeenCalledWith(101_000)
  })

  it('measures retry delay from the end of a slow follow-up cycle', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const ports = {
      sql: { listDueAlarmProbes: vi.fn(async () => []) },
    } as unknown as Ports

    await runAlarmWatcherCycle(
      ports,
      { setAlarm },
      millis(100_000),
      async () => ({ evaluated: 0, failed: 1, pending: 1 }),
      () => millis(300_000),
    )

    expect(setAlarm).toHaveBeenCalledWith(300_000 + ALARM_RETRY_DELAY_MILLISECONDS)
  })

  it('does not delete a replacement wakeup after an empty reconciliation', async () => {
    const setAlarm = vi.fn(async () => undefined)
    const deleteAlarm = vi.fn(async () => undefined)
    const storage = { setAlarm, deleteAlarm }
    const ports = {
      sql: {
        listDueAlarmProbes: vi.fn(async () => []),
        nextAlarmProbeAt: vi.fn(async () => null),
      },
    } as unknown as Ports

    await runAlarmWatcherCycle(
      ports,
      storage,
      millis(100_000),
      async () => ({ evaluated: 0, failed: 0, pending: 0 }),
      () => millis(100_000),
    )

    expect(setAlarm).not.toHaveBeenCalled()
    expect(deleteAlarm).not.toHaveBeenCalled()
  })
})
