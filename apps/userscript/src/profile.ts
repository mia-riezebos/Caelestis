export type ProfileKind = 'main' | 'worker' | 'gpu'

interface MutableStat {
  count: number
  totalMs: number
  maxMs: number
  recent: number[]
}

export interface ProfileStat {
  readonly count: number
  readonly totalMs: number
  readonly averageMs: number
  readonly maxMs: number
  readonly p95Ms: number
}

export interface ProfileTask extends ProfileStat {
  readonly name: string
  readonly kind: ProfileKind
}

export interface ProfileSnapshot {
  readonly enabled: boolean
  readonly elapsedMs: number
  readonly cpu: {
    readonly main: ProfileStat & { readonly dutyPercent: number }
    readonly worker: ProfileStat & { readonly dutyPercent: number }
  }
  readonly gpu: ProfileStat & { readonly supported: boolean | null }
  readonly frames: {
    readonly count: number
    readonly averageMs: number
    readonly p95Ms: number
    readonly maxMs: number
    readonly slow: number
    readonly estimatedFps: number | null
  }
  readonly longTasks: ProfileStat
  readonly memory: {
    readonly pageUsedJSHeapBytes: number | null
    readonly pageJSHeapLimitBytes: number | null
    readonly knownTotalBytes: number
    readonly known: readonly { readonly name: string; readonly bytes: number }[]
  }
  readonly tasks: readonly ProfileTask[]
  readonly scope: {
    readonly cpu: string
    readonly gpu: string
    readonly memory: string
    readonly pageSignals: string
  }
}

const PROFILE_KEY = 'caelestisProfile'
const RECENT_SAMPLES = 512
const FRAME_SAMPLES = 600
const SLOW_FRAME_MS = 1000 / 50
const EMPTY_STAT: ProfileStat = { count: 0, totalMs: 0, averageMs: 0, maxMs: 0, p95Ms: 0 }

let enabled = false
let startedAt = performance.now()
const tasks = new Map<
  string,
  { readonly name: string; readonly kind: ProfileKind; readonly stat: MutableStat }
>()
const memorySources = new Map<string, () => number>()

let frameRequest: number | null = null
let previousFrameAt: number | null = null
let frameCount = 0
let frameTotalMs = 0
let frameMaxMs = 0
let slowFrames = 0
let recentFrames: number[] = []

let longTaskObserver: PerformanceObserver | null = null
let pageLongTasks: MutableStat = { count: 0, totalMs: 0, maxMs: 0, recent: [] }
let gpuSupported: boolean | null = null

const percentile95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

const summary = (stat: MutableStat | undefined): ProfileStat => {
  if (stat === undefined || stat.count === 0) return EMPTY_STAT
  return {
    count: stat.count,
    totalMs: stat.totalMs,
    averageMs: stat.totalMs / stat.count,
    maxMs: stat.maxMs,
    p95Ms: percentile95(stat.recent),
  }
}

const combined = (kind: ProfileKind): ProfileStat => {
  const matching = [...tasks.values()].filter((task) => task.kind === kind)
  if (matching.length === 0) return EMPTY_STAT
  const merged: MutableStat = { count: 0, totalMs: 0, maxMs: 0, recent: [] }
  for (const { stat } of matching) {
    merged.count += stat.count
    merged.totalMs += stat.totalMs
    merged.maxMs = Math.max(merged.maxMs, stat.maxMs)
    merged.recent.push(...stat.recent)
  }
  if (merged.recent.length > RECENT_SAMPLES)
    merged.recent.splice(0, merged.recent.length - RECENT_SAMPLES)
  return summary(merged)
}

const stopObservers = (): void => {
  if (frameRequest !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frameRequest)
  }
  frameRequest = null
  previousFrameAt = null
  longTaskObserver?.disconnect()
  longTaskObserver = null
}

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

const startFrameObserver = (): void => {
  if (typeof requestAnimationFrame !== 'function') return
  const tick = (at: number): void => {
    if (!enabled) return
    if (previousFrameAt !== null && visible()) {
      const duration = at - previousFrameAt
      if (Number.isFinite(duration) && duration >= 0 && duration < 1_000) {
        frameCount++
        frameTotalMs += duration
        frameMaxMs = Math.max(frameMaxMs, duration)
        if (duration > SLOW_FRAME_MS) slowFrames++
        recentFrames.push(duration)
        if (recentFrames.length > FRAME_SAMPLES) recentFrames.shift()
      }
    }
    previousFrameAt = at
    frameRequest = requestAnimationFrame(tick)
  }
  frameRequest = requestAnimationFrame(tick)
}

const startLongTaskObserver = (): void => {
  if (typeof PerformanceObserver !== 'function') return
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = entry.duration
        if (!Number.isFinite(duration) || duration < 0) continue
        pageLongTasks.count++
        pageLongTasks.totalMs += duration
        pageLongTasks.maxMs = Math.max(pageLongTasks.maxMs, duration)
        pageLongTasks.recent.push(duration)
        if (pageLongTasks.recent.length > RECENT_SAMPLES) pageLongTasks.recent.shift()
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    longTaskObserver = null
  }
}

const startObservers = (): void => {
  stopObservers()
  startFrameObserver()
  startLongTaskObserver()
}

export const isProfileEnabled = (): boolean => enabled

export const setProfileEnabled = (on: boolean): void => {
  if (enabled === on) return
  enabled = on
  try {
    if (on) localStorage.setItem(PROFILE_KEY, '1')
    else localStorage.removeItem(PROFILE_KEY)
  } catch {}
  if (on) {
    resetProfile()
    startObservers()
  } else {
    stopObservers()
  }
}

export const installProfile = (): void => {
  let on = false
  try {
    on = localStorage.getItem(PROFILE_KEY) === '1'
  } catch {}
  setProfileEnabled(on)
}

export const resetProfile = (): void => {
  startedAt = performance.now()
  tasks.clear()
  frameCount = 0
  frameTotalMs = 0
  frameMaxMs = 0
  slowFrames = 0
  recentFrames = []
  pageLongTasks = { count: 0, totalMs: 0, maxMs: 0, recent: [] }
}

export const recordProfileDuration = (
  name: string,
  durationMs: number,
  kind: ProfileKind = 'main',
): void => {
  if (!enabled || !Number.isFinite(durationMs) || durationMs < 0) return
  const key = `${kind}\u0000${name}`
  let task = tasks.get(key)
  if (task === undefined) {
    task = { name, kind, stat: { count: 0, totalMs: 0, maxMs: 0, recent: [] } }
    tasks.set(key, task)
  }
  const { stat } = task
  stat.count++
  stat.totalMs += durationMs
  stat.maxMs = Math.max(stat.maxMs, durationMs)
  stat.recent.push(durationMs)
  if (stat.recent.length > RECENT_SAMPLES) stat.recent.shift()
}

export const measureProfile = <T>(name: string, run: () => T): T => {
  if (!enabled) return run()
  const start = performance.now()
  try {
    return run()
  } finally {
    recordProfileDuration(name, performance.now() - start, 'main')
  }
}

export const registerProfileMemorySource = (name: string, read: () => number): (() => void) => {
  memorySources.set(name, read)
  return () => {
    if (memorySources.get(name) === read) memorySources.delete(name)
  }
}

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: GLenum
  readonly GPU_DISJOINT_EXT: GLenum
}

interface PendingGpuQuery {
  readonly query: WebGLQuery
  readonly name: string
}

interface GpuTimerState {
  readonly extension: TimerExtension
  readonly pending: PendingGpuQuery[]
}

const gpuTimers = new WeakMap<WebGL2RenderingContext, GpuTimerState>()
const MAX_PENDING_GPU_QUERIES = 8

const timerState = (gl: WebGL2RenderingContext): GpuTimerState | null => {
  const existing = gpuTimers.get(gl)
  if (existing !== undefined) return existing
  try {
    const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
    if (extension === null) {
      if (gpuSupported === null) gpuSupported = false
      return null
    }
    gpuSupported = true
    const created = { extension, pending: [] }
    gpuTimers.set(gl, created)
    return created
  } catch {
    if (gpuSupported === null) gpuSupported = false
    return null
  }
}

const collectGpuQueries = (gl: WebGL2RenderingContext, state: GpuTimerState): void => {
  try {
    if (gl.getParameter(state.extension.GPU_DISJOINT_EXT)) {
      for (const pending of state.pending.splice(0)) gl.deleteQuery(pending.query)
      return
    }
    for (let index = state.pending.length - 1; index >= 0; index--) {
      const pending = state.pending[index]
      if (pending === undefined) continue
      if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) continue
      const nanoseconds = Number(gl.getQueryParameter(pending.query, gl.QUERY_RESULT))
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
        recordProfileDuration(pending.name, nanoseconds / 1_000_000, 'gpu')
      }
      gl.deleteQuery(pending.query)
      state.pending.splice(index, 1)
    }
  } catch {
    for (const pending of state.pending.splice(0)) {
      try {
        gl.deleteQuery(pending.query)
      } catch {}
    }
  }
}

export const profileGpu = <T>(gl: WebGL2RenderingContext, name: string, draw: () => T): T => {
  const known = gpuTimers.get(gl)
  if (!enabled) {
    if (known !== undefined) collectGpuQueries(gl, known)
    return draw()
  }
  const state = timerState(gl)
  if (state === null) return draw()
  collectGpuQueries(gl, state)
  if (state.pending.length >= MAX_PENDING_GPU_QUERIES) return draw()
  const query = gl.createQuery()
  if (query === null) return draw()
  try {
    gl.beginQuery(state.extension.TIME_ELAPSED_EXT, query)
  } catch {
    gl.deleteQuery(query)
    return draw()
  }
  try {
    return draw()
  } finally {
    try {
      gl.endQuery(state.extension.TIME_ELAPSED_EXT)
      state.pending.push({ query, name })
    } catch {
      gl.deleteQuery(query)
    }
  }
}

export const clearGpuProfile = (gl: WebGL2RenderingContext): void => {
  const state = gpuTimers.get(gl)
  if (state === undefined) return
  for (const pending of state.pending) {
    try {
      gl.deleteQuery(pending.query)
    } catch {}
  }
  gpuTimers.delete(gl)
}

const pageHeap = (): { used: number | null; limit: number | null } => {
  const memory = (
    performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize?: number; readonly jsHeapSizeLimit?: number }
    }
  ).memory
  const used = Number(memory?.usedJSHeapSize)
  const limit = Number(memory?.jsHeapSizeLimit)
  return {
    used: Number.isFinite(used) && used >= 0 ? used : null,
    limit: Number.isFinite(limit) && limit >= 0 ? limit : null,
  }
}

export const profileSnapshot = (): ProfileSnapshot => {
  if (!enabled) {
    return {
      enabled,
      elapsedMs: 0,
      cpu: {
        main: { ...EMPTY_STAT, dutyPercent: 0 },
        worker: { ...EMPTY_STAT, dutyPercent: 0 },
      },
      gpu: { ...EMPTY_STAT, supported: gpuSupported },
      frames: { count: 0, averageMs: 0, p95Ms: 0, maxMs: 0, slow: 0, estimatedFps: null },
      longTasks: EMPTY_STAT,
      memory: {
        pageUsedJSHeapBytes: null,
        pageJSHeapLimitBytes: null,
        knownTotalBytes: 0,
        known: [],
      },
      tasks: [],
      scope: {
        cpu: 'Instrumented Caelestis work only.',
        gpu: 'Caelestis WebGL layers only, when timer queries are available.',
        memory: 'Known Caelestis pixel and GPU buffers. Object overhead is not included.',
        pageSignals: 'Frame cadence, long tasks and page heap cover the whole tab.',
      },
    }
  }

  const elapsedMs = Math.max(0, performance.now() - startedAt)
  const main = combined('main')
  const worker = combined('worker')
  const gpu = combined('gpu')
  const known = [...memorySources.entries()]
    .map(([name, read]) => {
      try {
        const bytes = Number(read())
        return { name, bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0 }
      } catch {
        return { name, bytes: 0 }
      }
    })
    .sort((a, b) => b.bytes - a.bytes)
  const heap = pageHeap()
  const longTasks = summary(pageLongTasks)
  const taskRows = [...tasks.values()]
    .map((task) => ({ name: task.name, kind: task.kind, ...summary(task.stat) }))
    .sort((a, b) => b.totalMs - a.totalMs)

  return {
    enabled,
    elapsedMs,
    cpu: {
      main: { ...main, dutyPercent: elapsedMs > 0 ? (main.totalMs / elapsedMs) * 100 : 0 },
      worker: { ...worker, dutyPercent: elapsedMs > 0 ? (worker.totalMs / elapsedMs) * 100 : 0 },
    },
    gpu: { ...gpu, supported: gpuSupported },
    frames: {
      count: frameCount,
      averageMs: frameCount > 0 ? frameTotalMs / frameCount : 0,
      p95Ms: percentile95(recentFrames),
      maxMs: frameMaxMs,
      slow: slowFrames,
      estimatedFps: frameCount > 0 && frameTotalMs > 0 ? 1000 / (frameTotalMs / frameCount) : null,
    },
    longTasks,
    memory: {
      pageUsedJSHeapBytes: heap.used,
      pageJSHeapLimitBytes: heap.limit,
      knownTotalBytes: known.reduce((total, source) => total + source.bytes, 0),
      known,
    },
    tasks: taskRows,
    scope: {
      cpu: 'Instrumented Caelestis work only.',
      gpu: 'Caelestis WebGL layers only, when timer queries are available.',
      memory: 'Known Caelestis pixel and GPU buffers. Object overhead is not included.',
      pageSignals: 'Frame cadence, long tasks and page heap cover the whole tab.',
    },
  }
}

export const profileReport = (): string =>
  JSON.stringify({ generatedAt: new Date().toISOString(), ...profileSnapshot() }, null, 2)
