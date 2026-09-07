import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureProfileRun,
  measureProfile,
  measureProfileDetail,
  profileGpu,
  profileSnapshot,
  recordProfileAction,
  recordProfileCounter,
  recordProfileDuration,
  recordProfileWorkload,
  registerProfileContextSource,
  registerProfileMemorySource,
  resetProfile,
  setProfileEnabled,
} from './profile.js'
import type { ProfileContext } from './profile-context.js'

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
  it('counts events only within the enabled window and bounds distinct keys', () => {
    recordProfileCounter('bytes', 99)
    setProfileEnabled(true)
    recordProfileCounter('bytes', 4)
    recordProfileCounter('bytes', 8)
    expect(profileSnapshot().counters).toEqual({ bytes: 12 })
    resetProfile()
    expect(profileSnapshot().counters).toEqual({})
    for (let i = 0; i < 257; i++) recordProfileCounter(`event ${i}`)
    expect(Object.keys(profileSnapshot().counters)).toHaveLength(256)
    expect(profileSnapshot().counterKeysDropped).toBe(1)
  })

  it('captures start and current context without reading app state while disabled', () => {
    const context: ProfileContext = {
      build: { version: 'test', revision: 'abc', dirty: false, development: true },
      environment: {
        userAgent: 'test',
        platform: 'test',
        hardwareConcurrency: 8,
        deviceMemoryGiB: null,
        devicePixelRatio: 2,
        viewport: { width: 1280, height: 720 },
        screen: { width: 2560, height: 1440 },
        visualViewportScale: 1,
        visibility: 'visible',
      },
      camera: { longitude: 0, latitude: 0, zoom: 11 },
      surface: 'world',
      templates: { loaded: 10, enabled: 8, drawing: 7 },
      paint: { open: false, selectedColour: null },
    }
    const read = vi.fn(() => context)
    const unregister = registerProfileContextSource(read)
    profileSnapshot()
    expect(read).not.toHaveBeenCalled()
    setProfileEnabled(true)
    const changed = { ...context, paint: { open: true, selectedColour: 3 } }
    read.mockReturnValue(changed)
    expect(profileSnapshot().context).toEqual({ start: context, current: changed })
    resetProfile()
    expect(profileSnapshot().context.start).toEqual(changed)
    unregister()
  })

  it('bounds action history, preserves timestamps, and clears run annotations on reset', () => {
    recordProfileAction('disabled')
    setProfileEnabled(true)
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(100)
    resetProfile()
    configureProfileRun({ label: 'Box Art idle', browserZoomPercent: 25 })
    now.mockReturnValue(150)
    for (let i = 0; i < 201; i++) recordProfileAction(`action ${i}`)
    const snapshot = profileSnapshot()
    expect(snapshot.actions).toHaveLength(200)
    expect(snapshot.actions[0]).toEqual({ name: 'action 1', atMs: 50, trusted: null })
    expect(snapshot.actionsDropped).toBe(1)
    expect(snapshot.run.browserZoomPercent).toBe(25)
    expect(() => configureProfileRun({ label: '', browserZoomPercent: Number.NaN })).toThrow(
      TypeError,
    )
    resetProfile()
    expect(profileSnapshot().actions).toEqual([])
    expect(profileSnapshot().run).toEqual({ label: '', browserZoomPercent: null })
  })

  it('distinguishes unsupported long tasks from a failing observer', () => {
    vi.stubGlobal('PerformanceObserver', undefined)
    setProfileEnabled(true)
    expect(profileSnapshot().longTasks).toMatchObject({ supported: false, observing: false })
    setProfileEnabled(false)
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask']
        observe() {
          throw new Error('unavailable')
        }
      },
    )
    setProfileEnabled(true)
    expect(profileSnapshot().longTasks).toMatchObject({ supported: true, observing: false })
  })

  it('does not include the frame interval preceding a reset', () => {
    let frame: FrameRequestCallback = () => undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setProfileEnabled(true)
    frame(100)
    frame(116)
    expect(profileSnapshot().frames.count).toBe(1)
    resetProfile()
    frame(500)
    expect(profileSnapshot().frames.count).toBe(0)
    frame(516)
    expect(profileSnapshot().frames.averageMs).toBe(16)
  })

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

  it('uses chronological samples for aggregate percentiles rather than task insertion order', () => {
    setProfileEnabled(true)
    recordProfileDuration('slow', 50)
    for (let i = 0; i < 512; i++) recordProfileDuration('fast', 1)
    for (let i = 0; i < 512; i++) recordProfileDuration('slow', 50)
    expect(profileSnapshot().cpu.main.p95Ms).toBe(50)
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

  it('evicts completed GPU samples in execution order when a batch becomes available', async () => {
    setProfileEnabled(true)
    let nextQuery = 0
    const gl = {
      QUERY_RESULT_AVAILABLE: 3,
      QUERY_RESULT: 4,
      getExtension: () => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }),
      createQuery: () => ({ id: nextQuery++ }),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getQueryParameter: (query: { id: number }, parameter: number) =>
        parameter === 3 || (query.id === 0 ? 50_000_000 : 1_000_000),
      getParameter: () => false,
      deleteQuery: vi.fn(),
    } as unknown as WebGL2RenderingContext

    profileGpu(gl, 'overlay', () => undefined)
    profileGpu(gl, 'outline', () => undefined)
    await Promise.resolve()
    profileGpu(gl, 'overlay', () => undefined)
    expect(profileSnapshot().gpu.count).toBe(2)

    // Only the oldest (50 ms) query leaves the window. The remaining 25 slow samples
    // stay below the p95 cutoff; evicting the newer 1 ms query crosses that cutoff.
    for (let i = 0; i < 511; i++) recordProfileDuration('markers', i < 25 ? 50 : 1, 'gpu')
    expect(profileSnapshot().gpu.p95Ms).toBe(1)
    resetProfile()
    await Promise.resolve()
    profileGpu(gl, 'overlay', () => undefined)
    expect(profileSnapshot().gpu.count).toBe(0)
    setProfileEnabled(false)
    profileGpu(gl, 'overlay', () => undefined)
  })

  it('collects GPU queries once per frame and retires all polling when disabled', async () => {
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
    await Promise.resolve()
    profileGpu(gl, 'overlay', draw)

    expect(draw).toHaveBeenCalledTimes(2)
    expect(profileSnapshot().gpu.totalMs).toBe(2)
    profileGpu(gl, 'outline', draw)
    profileGpu(gl, 'markers', draw)
    expect(gl.getParameter).toHaveBeenCalledTimes(1)
    setProfileEnabled(false)
    profileGpu(gl, 'overlay', draw)
    vi.mocked(gl.getParameter).mockClear()
    for (let i = 0; i < 10; i++) profileGpu(gl, 'overlay', draw)
    expect(gl.getParameter).not.toHaveBeenCalled()
  })
})
