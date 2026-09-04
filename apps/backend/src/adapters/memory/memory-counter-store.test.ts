import { millis, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { COUNTER_IDEMPOTENCY_RETENTION_SECONDS } from '../../ports/index.js'
import { MemoryCounterStore } from './memory-counter-store.js'
import { MemorySqlStore } from './memory-sql-store.js'

describe('MemoryCounterStore', () => {
  it('records an idempotency key once', async () => {
    const counters = new MemoryCounterStore(new MemorySqlStore(), () => millis(150_000))
    const delta = {
      templateId: 'template-a',
      occurredAt: seconds(100),
      placed: 4,
      correct: 3,
      repairs: 1,
    }

    await counters.record([delta], 'event-1')
    await counters.record([delta], 'event-1')

    await expect(counters.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
  })

  it('forgets idempotency keys after every initially valid counter has expired', async () => {
    const clock = { now: millis(150_000) }
    const counters = new MemoryCounterStore(new MemorySqlStore(), () => clock.now)
    await counters.record([], 'old-event')
    clock.now = millis(clock.now + COUNTER_IDEMPOTENCY_RETENTION_SECONDS * 1_000 + 1)

    await counters.record([], 'new-event')
    await counters.record(
      [
        {
          templateId: 'template-a',
          occurredAt: seconds(Math.floor(clock.now / 1_000)),
          placed: 1,
          correct: 1,
          repairs: 0,
        },
      ],
      'old-event',
    )

    await expect(counters.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 1, correct: 1, repairs: 0, flushedAt: null },
    ])
  })

  it.each([
    ['the same bucket', seconds(101)],
    ['another pending bucket', seconds(121)],
  ])('rejects an update that would overflow %s', async (_case, secondTimestamp) => {
    const counters = new MemoryCounterStore(new MemorySqlStore(), () => millis(150_000))
    await counters.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: Number.MAX_SAFE_INTEGER,
        correct: Number.MAX_SAFE_INTEGER,
        repairs: Number.MAX_SAFE_INTEGER,
      },
      {
        templateId: 'template-a',
        occurredAt: secondTimestamp,
        placed: 2,
        correct: 2,
        repairs: 2,
      },
    ])

    await expect(counters.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: Number.MAX_SAFE_INTEGER,
        correct: Number.MAX_SAFE_INTEGER,
        repairs: Number.MAX_SAFE_INTEGER,
        flushedAt: null,
      },
    ])
    await expect(counters.readDroppedLateCount()).resolves.toBe(1)
  })

  it('rejects a late update that would overflow a retained bucket', async () => {
    const counters = new MemoryCounterStore(new MemorySqlStore(), () => millis(150_000))
    await counters.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: Number.MAX_SAFE_INTEGER,
        correct: Number.MAX_SAFE_INTEGER,
        repairs: Number.MAX_SAFE_INTEGER,
      },
    ])
    await counters.alarm()

    await counters.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: 2,
        correct: 2,
        repairs: 2,
      },
    ])

    await expect(counters.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: millis(150_000),
      },
    ])
    await expect(counters.readDroppedLateCount()).resolves.toBe(1)
  })
})
