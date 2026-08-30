import { millis } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqlStore, TemplateVersionRecord } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const TOKEN = 'a'.repeat(64)
const TEMPLATE_ID = '01890f3a-6b7c-7def-8123-456789abcde1'
const VERSION_ID = '01890f3a-6b7c-7def-8123-456789abcde2'
const NEXT_VERSION_ID = '01890f3a-6b7c-7def-8123-456789abcde3'
const ALARM_ID = '01890f3a-6b7c-7def-8123-456789abcde4'
const NOW = millis(1_750_000_000_000)
const SIX_HOURS_LATER = millis(NOW + 6 * 60 * 60 * 1_000)
const PROBE_AT = millis(SIX_HOURS_LATER + 10 * 60 * 1_000)

const version = (versionId = VERSION_ID): TemplateVersionRecord => ({
  templateId: TEMPLATE_ID,
  season: 1,
  nodeId: null,
  name: 'Alarm test',
  versionId,
  createdWithToken: TOKEN,
  createdByUserId: null,
  createdAt: NOW,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 100_000,
  chunks: [{ tileX: 0, tileY: 0, hash: 'c'.repeat(64) }],
})

const snapshot = (correct: number, observedAt = NOW, versionId = VERSION_ID) => ({
  templateId: TEMPLATE_ID,
  versionId,
  total: 100_000,
  correct,
  observedAt,
})

type Harness = { store: SqlStore; close(): void }

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => ({ store: new MemorySqlStore(), close: () => undefined }),
  },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      return {
        store: new D1SqlStore(database as unknown as D1Database),
        close: () => database.close(),
      }
    },
  },
]

describe.each(adapters)('$name alarm-store contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(async () => {
    harness = make()
    store = harness.store
    await store.insertTemplateVersion(version())
    await store.setTemplatePublishedAt(TEMPLATE_ID, NOW, NOW)
  })

  afterEach(() => harness.close())

  it('persists one alarm episode and promotes it only after a worsening due probe', async () => {
    await expect(
      store.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, ALARM_ID),
    ).resolves.toMatchObject({ scheduleFollowUp: false })

    await expect(
      store.evaluateTemplateAlarm(snapshot(59_900, SIX_HOURS_LATER), { kind: 'scan' }, ALARM_ID),
    ).resolves.toMatchObject({ scheduleFollowUp: true })
    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([
      expect.objectContaining({ id: ALARM_ID, kind: 'regression', pixelsLost: 100 }),
    ])
    await expect(store.nextAlarmProbeAt()).resolves.toBe(PROBE_AT)
    await store.clearAlarmProbe(TEMPLATE_ID, 'not-this-episode')
    await expect(store.nextAlarmProbeAt()).resolves.toBe(PROBE_AT)
    await expect(store.listDueAlarmProbes(millis(PROBE_AT - 1))).resolves.toEqual([])
    await expect(store.listDueAlarmProbes(PROBE_AT)).resolves.toEqual([
      {
        templateId: TEMPLATE_ID,
        versionId: VERSION_ID,
        season: 1,
        alarmId: ALARM_ID,
        pixelsLost: 100,
        dueAt: PROBE_AT,
      },
    ])

    await store.evaluateTemplateAlarm(
      snapshot(59_899, PROBE_AT),
      { kind: 'follow-up', alarmId: ALARM_ID, pixelsLost: 100 },
      'unused',
    )
    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([
      expect.objectContaining({ kind: 'sustained-griefing', pixelsLost: 101 }),
    ])
    await expect(store.nextAlarmProbeAt()).resolves.toBeNull()

    await store.evaluateTemplateAlarm(
      snapshot(60_000, millis(PROBE_AT + 1)),
      { kind: 'scan' },
      'unused',
    )
    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([])
  })

  it('can abandon a failed follow-up without clearing the regression', async () => {
    await store.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, ALARM_ID)
    await store.evaluateTemplateAlarm(snapshot(59_900, SIX_HOURS_LATER), { kind: 'scan' }, ALARM_ID)

    await store.clearAlarmProbe(TEMPLATE_ID, ALARM_ID)

    await expect(store.nextAlarmProbeAt()).resolves.toBeNull()
    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([
      expect.objectContaining({ id: ALARM_ID, kind: 'regression' }),
    ])
  })

  it('does not let an overlapping scan overwrite a worsening follow-up', async () => {
    await store.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, ALARM_ID)
    await store.evaluateTemplateAlarm(snapshot(59_900, SIX_HOURS_LATER), { kind: 'scan' }, ALARM_ID)

    await Promise.all([
      store.evaluateTemplateAlarm(
        snapshot(59_800, PROBE_AT),
        { kind: 'follow-up', alarmId: ALARM_ID, pixelsLost: 100 },
        'unused',
      ),
      store.evaluateTemplateAlarm(snapshot(59_900, PROBE_AT), { kind: 'scan' }, 'unused'),
    ])

    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([
      expect.objectContaining({ kind: 'sustained-griefing', pixelsLost: 100 }),
    ])
    await expect(store.nextAlarmProbeAt()).resolves.toBeNull()
  })

  it('preserves a newer probe when an obsolete follow-up arrives', async () => {
    await store.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, ALARM_ID)
    await store.evaluateTemplateAlarm(snapshot(59_900, SIX_HOURS_LATER), { kind: 'scan' }, ALARM_ID)
    await store.evaluateTemplateAlarm(snapshot(60_000, PROBE_AT), { kind: 'scan' }, 'unused')
    const newerAt = millis(PROBE_AT + 1)
    await store.evaluateTemplateAlarm(snapshot(59_800, newerAt), { kind: 'scan' }, 'alarm-new')

    await store.evaluateTemplateAlarm(
      snapshot(59_700, millis(newerAt + 1)),
      { kind: 'follow-up', alarmId: ALARM_ID, pixelsLost: 100 },
      'unused',
    )

    await expect(store.nextAlarmProbeAt()).resolves.toBe(newerAt + 10 * 60 * 1_000)
    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([
      expect.objectContaining({ id: 'alarm-new', kind: 'regression', pixelsLost: 200 }),
    ])
  })

  it('keeps unpublished alarms admin-only and resets the baseline on a new version', async () => {
    await store.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, ALARM_ID)
    await store.evaluateTemplateAlarm(snapshot(59_900, SIX_HOURS_LATER), { kind: 'scan' }, ALARM_ID)
    await store.setTemplatePublishedAt(TEMPLATE_ID, null, millis(SIX_HOURS_LATER + 1))

    await expect(store.readActiveAlarms(1, false)).resolves.toEqual([])
    await expect(store.readActiveAlarms(1, true)).resolves.toHaveLength(1)

    await store.insertTemplateVersion(version(NEXT_VERSION_ID), { requireExisting: true })
    await expect(store.nextAlarmProbeAt()).resolves.toBeNull()
    await store.evaluateTemplateAlarm(
      snapshot(20_000, millis(SIX_HOURS_LATER + 2), NEXT_VERSION_ID),
      { kind: 'scan' },
      'unused',
    )
    await expect(store.readActiveAlarms(1, true)).resolves.toEqual([])
    await expect(store.nextAlarmProbeAt()).resolves.toBeNull()
  })
})
