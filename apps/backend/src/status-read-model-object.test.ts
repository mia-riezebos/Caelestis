import { millis, type TemplateStatus } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import { DurableStatusProjectionStorage } from './status-read-model-object.js'

class MemoryDurableStorage {
  readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async delete(keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1
    }
    return deleted
  }

  async list<T>(options: {
    readonly prefix?: string
    readonly startAfter?: string
    readonly limit?: number
  }): Promise<Map<string, T>> {
    const keys = [...this.values.keys()]
      .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .sort()
      .slice(0, options.limit)
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key)) as T]))
  }
}

const status = (index: number): TemplateStatus => ({
  templateId: `template-${String(index).padStart(5, '0')}`,
  correct: index,
  wrong: 0,
  blank: 1,
  total: index + 1,
  observedAt: millis(index),
})

describe('DurableStatusProjectionStorage', () => {
  it('does not persist invented empty revision-zero seasons', async () => {
    const backing = new MemoryDurableStorage()
    const storage = new DurableStatusProjectionStorage(backing as unknown as DurableObjectStorage)

    await storage.write(999_999, 'read', {
      response: { season: 999_999, revision: 0, templates: [] },
      reconciledAt: 1,
    })

    expect(backing.values.size).toBe(0)
    await expect(storage.read(999_999, 'read')).resolves.toBeNull()
  })

  it('stores large snapshots as revision-qualified rows and cleans old revisions', async () => {
    const backing = new MemoryDurableStorage()
    const storage = new DurableStatusProjectionStorage(backing as unknown as DurableObjectStorage)
    const templates = Array.from({ length: 1_005 }, (_, index) => status(index))

    await storage.write(4, 'admin', {
      response: { season: 4, revision: 7, templates },
      reconciledAt: 10,
    })

    await expect(storage.read(4, 'admin')).resolves.toEqual({
      response: { season: 4, revision: 7, templates },
      reconciledAt: 10,
    })
    expect(
      [...backing.values.values()].some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'templates' in value &&
          Array.isArray(value.templates),
      ),
    ).toBe(false)

    await storage.write(4, 'admin', {
      response: { season: 4, revision: 8, templates: [status(2_000)] },
      reconciledAt: 20,
    })

    await expect(storage.read(4, 'admin')).resolves.toEqual({
      response: { season: 4, revision: 8, templates: [status(2_000)] },
      reconciledAt: 20,
    })
    expect([...backing.values.keys()].some((key) => key.includes(':7:'))).toBe(false)
  })
})
