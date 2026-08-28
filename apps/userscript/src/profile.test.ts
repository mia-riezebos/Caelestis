import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  measureProfile,
  measureProfileDetail,
  profileGpu,
  profileSnapshot,
  recordProfileDuration,
  recordProfileWorkload,
  registerProfileMemorySource,
  resetProfile,
  setProfileEnabled,
} from './profile.js'

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  setProfileEnabled(false)
  resetProfile()
})

afterEach(() => {
  setProfileEnabled(false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('performance profile', () => {
  it('does no timing work while disabled', () => {
    const now = vi.spyOn(performance, 'now')

    expect(measureProfile('frame hook', () => 42)).toBe(42)
    recordProfileDuration('worker scan', 8, 'worker')

    expect(now).not.toHaveBeenCalled()
    expect(profileSnapshot().tasks).toEqual([])
  })

  it('separates measured main-thread, worker and GPU time', () => {
    setProfileEnabled(true)
    recordProfileDuration('work', 4, 'main')
    recordProfileDuration('work', 7, 'worker')
    recordProfileDuration('work', 2, 'gpu')

    const snapshot = profileSnapshot()
    expect(snapshot.cpu.main.totalMs).toBe(4)
    expect(snapshot.cpu.worker.totalMs).toBe(7)
    expect(snapshot.gpu.totalMs).toBe(2)
    expect(snapshot.tasks.map((task) => `${task.kind}:${task.name}`)).toEqual([
      'worker:work',
      'main:work',
      'gpu:work',
    ])
  })

  it('reports nested detail without double-counting it as CPU duty', () => {
    setProfileEnabled(true)
    recordProfileDuration('frame', 5)
    measureProfileDetail('upload', () => undefined)

    const snapshot = profileSnapshot()
    expect(snapshot.cpu.main.totalMs).toBe(5)
    expect(snapshot.tasks.some((task) => task.kind === 'detail' && task.name === 'upload')).toBe(
      true,
    )
  })

  it('summarises render workload without recording while disabled', () => {
    recordProfileWorkload('Overlay visible templates', 99)
    expect(profileSnapshot().workload).toEqual([])

    setProfileEnabled(true)
    recordProfileWorkload('Overlay visible templates', 4)
    recordProfileWorkload('Overlay visible templates', 8)

    expect(profileSnapshot().workload).toEqual([
      {
        name: 'Overlay visible templates',
        count: 2,
        current: 8,
        average: 6,
        max: 8,
        p95: 8,
      },
    ])

    resetProfile()
    expect(profileSnapshot().workload).toEqual([])
  })

  it('reports registered Caelestis buffers without calling them while disabled', () => {
    const source = vi.fn(() => 4_096)
    const unregister = registerProfileMemorySource('template pixels', source)

    expect(profileSnapshot().memory.known).toEqual([])
    expect(source).not.toHaveBeenCalled()

    setProfileEnabled(true)
    expect(profileSnapshot().memory.known).toEqual([{ name: 'template pixels', bytes: 4_096 }])
    unregister()
  })

  it('collects a completed WebGL timer query without blocking the draw', () => {
    setProfileEnabled(true)
    const query = {}
    const extension = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }
    const gl = {
      QUERY_RESULT_AVAILABLE: 3,
      QUERY_RESULT: 4,
      getExtension: vi.fn(() => extension),
      createQuery: vi.fn(() => query),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getQueryParameter: vi.fn((_query, parameter) => parameter === 3 || 2_000_000),
      getParameter: vi.fn(() => false),
      deleteQuery: vi.fn(),
    } as unknown as WebGL2RenderingContext
    const draw = vi.fn()

    profileGpu(gl, 'overlay', draw)
    profileGpu(gl, 'overlay', draw)

    expect(draw).toHaveBeenCalledTimes(2)
    expect(profileSnapshot().gpu.totalMs).toBe(2)
  })
})
