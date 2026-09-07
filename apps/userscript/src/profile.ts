import type { ProfileContext } from './profile-context.js'

export type ProfileKind = 'main' | 'worker' | 'gpu' | 'detail'

export interface ProfileAction {
  readonly atMs: number
  readonly name: string
  readonly trusted: boolean | null
}

export interface ProfileRun {
  readonly label: string
  /** Browser zoom cannot be inferred from DPR or pinch scale. Supply the browser's actual setting. */
  readonly browserZoomPercent: number | null
}

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

interface MutableWorkload {
  count: number
  total: number
  current: number
  max: number
  recent: number[]
}

export interface ProfileWorkload {
  readonly name: string
  readonly count: number
  readonly current: number
  readonly average: number
  readonly max: number
  readonly p95: number
}

export interface ProfileSnapshot {
  readonly enabled: boolean
  readonly elapsedMs: number
  readonly context: {
    readonly start: ProfileContext | null
    readonly current: ProfileContext | null
  }
  readonly run: ProfileRun
  readonly actions: readonly ProfileAction[]
  readonly actionsDropped: number
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
  readonly longTasks: ProfileStat & { readonly supported: boolean; readonly observing: boolean }
  readonly memory: {
    readonly pageUsedJSHeapBytes: number | null
    readonly pageJSHeapLimitBytes: number | null
    readonly knownTotalBytes: number
    readonly known: readonly { readonly name: string; readonly bytes: number }[]
  }
  readonly tasks: readonly ProfileTask[]
  readonly workload: readonly ProfileWorkload[]
  readonly scope: {
    readonly cpu: string
    readonly gpu: string
    readonly memory: string
    readonly pageSignals: string
    readonly workload: string
    readonly context: string
    readonly actions: string
  }
}

const PROFILE_KEY = 'caelestisProfile'
const RECENT_SAMPLES = 512
const FRAME_SAMPLES = 600
const MAX_ACTIONS = 200
const MAX_ACTION_NAME = 100
const SLOW_FRAME_MS = 1000 / 50
const EMPTY_STAT: ProfileStat = { count: 0, totalMs: 0, averageMs: 0, maxMs: 0, p95Ms: 0 }

let enabled = false
let startedAt = performance.now()
const tasks = new Map<
  string,
  { readonly name: string; readonly kind: ProfileKind; readonly stat: MutableStat }
>()
const workload = new Map<string, MutableWorkload>()
const recentByKind = new Map<ProfileKind, number[]>()
const memorySources = new Map<string, () => number>()
let contextSource: (() => ProfileContext) | null = null
let startContext: ProfileContext | null = null
let run: ProfileRun = { label: '', browserZoomPercent: null }
let actions: ProfileAction[] = []
let actionsDropped = 0

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

const supportsLongTasks = (): boolean =>
  typeof PerformanceObserver === 'function' &&
  PerformanceObserver.supportedEntryTypes?.includes('longtask') === true

/** Register the app-owned report context without making the profiler depend on app state. */
export const registerProfileContextSource = (read: () => ProfileContext): (() => void) => {
  contextSource = read
  if (enabled) startContext = read()
  return () => {
    if (contextSource === read) contextSource = null
  }
}

/** Annotate a run with its scenario and externally measured browser zoom. Resets clear annotations. */
export const configureProfileRun = (value: ProfileRun): void => {
  if (
    typeof value.label !== 'string' ||
    (value.browserZoomPercent !== null &&
      (!Number.isFinite(value.browserZoomPercent) || value.browserZoomPercent <= 0))
  )
    throw new TypeError('Provide a label and a positive browserZoomPercent, or null when unknown.')
  run = {
    label: value.label.slice(0, MAX_ACTION_NAME),
    browserZoomPercent: value.browserZoomPercent,
  }
}

/** Mark an action relative to the current sample window, without retaining input text or DOM nodes. */
export const recordProfileAction = (name: string, trusted: boolean | null = null): void => {
  if (!enabled) return
  actions.push({
    atMs: Math.max(0, performance.now() - startedAt),
    name: name.slice(0, MAX_ACTION_NAME),
    trusted,
  })
  if (actions.length > MAX_ACTIONS) {
    actions.shift()
    actionsDropped++
  }
}

const recordInput = (event: Event): void => {
  if (!event.isTrusted) return
  if (event.type === 'keydown') {
    const keyboard = event as KeyboardEvent
    if (keyboard.key === 'Escape') recordProfileAction('Escape', true)
    else if (
      (keyboard.ctrlKey || keyboard.metaKey) &&
      ['z', 'y'].includes(keyboard.key.toLowerCase())
    )
      recordProfileAction(
        keyboard.key.toLowerCase() === 'y' || keyboard.shiftKey ? 'redo shortcut' : 'undo shortcut',
        true,
      )
    return
  }
  recordProfileAction(event.type, true)
}

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
  }
  merged.recent = recentByKind.get(kind) ?? []
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
  globalThis.document?.removeEventListener('pointerdown', recordInput, true)
  globalThis.document?.removeEventListener('pointerup', recordInput, true)
  globalThis.document?.removeEventListener('keydown', recordInput, true)
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
  if (!supportsLongTasks()) return
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
  globalThis.document?.addEventListener('pointerdown', recordInput, {
    capture: true,
    passive: true,
  })
  globalThis.document?.addEventListener('pointerup', recordInput, { capture: true, passive: true })
  globalThis.document?.addEventListener('keydown', recordInput, { capture: true, passive: true })
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

/** Start a fresh measurement window, including context, annotations, actions, and samples. */
export const resetProfile = (): void => {
  recentByKind.clear()
  startedAt = performance.now()
  previousFrameAt = null
  startContext = enabled ? (contextSource?.() ?? null) : null
  run = { label: '', browserZoomPercent: null }
  actions = []
  actionsDropped = 0
  tasks.clear()
  workload.clear()
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
  const recent = recentByKind.get(kind) ?? []
  recent.push(durationMs)
  if (recent.length > RECENT_SAMPLES) recent.shift()
  recentByKind.set(kind, recent)
}

/** Record one per-frame workload gauge without paying for it while profiling is disabled. */
export const recordProfileWorkload = (name: string, value: number): void => {
  if (!enabled || !Number.isFinite(value) || value < 0) return
  let metric = workload.get(name)
  if (metric === undefined) {
    metric = { count: 0, total: 0, current: 0, max: 0, recent: [] }
    workload.set(name, metric)
  }
  metric.count++
  metric.total += value
  metric.current = value
  metric.max = Math.max(metric.max, value)
  metric.recent.push(value)
  if (metric.recent.length > RECENT_SAMPLES) metric.recent.shift()
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

/** Nested diagnostic timing that stays out of aggregate CPU duty to avoid double-counting. */
export const measureProfileDetail = <T>(name: string, run: () => T): T => {
  if (!enabled) return run()
  const start = performance.now()
  try {
    return run()
  } finally {
    recordProfileDuration(name, performance.now() - start, 'detail')
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
  collectedThisFrame: boolean
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
    const created = { extension, pending: [], collectedThisFrame: false }
    gpuTimers.set(gl, created)
    return created
  } catch {
    if (gpuSupported === null) gpuSupported = false
    return null
  }
}

const collectGpuQueries = (gl: WebGL2RenderingContext, state: GpuTimerState): void => {
  // MapLibre invokes its custom passes synchronously. Share one collection across those passes,
  // then release the guard after the host frame, without starting another animation loop.
  if (state.collectedThisFrame) return
  state.collectedThisFrame = true
  queueMicrotask(() => {
    state.collectedThisFrame = false
  })
  if (state.pending.length === 0) return
  try {
    if (gl.getParameter(state.extension.GPU_DISJOINT_EXT)) {
      for (const pending of state.pending.splice(0)) gl.deleteQuery(pending.query)
      return
    }
    while (state.pending.length > 0) {
      const pending = state.pending[0]
      if (pending === undefined) break
      if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) break
      const nanoseconds = Number(gl.getQueryParameter(pending.query, gl.QUERY_RESULT))
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
        recordProfileDuration(pending.name, nanoseconds / 1_000_000, 'gpu')
      }
      gl.deleteQuery(pending.query)
      state.pending.shift()
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
    if (known !== undefined) clearGpuProfile(gl)
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
  const metadata = {
    context: {
      start: enabled ? startContext : null,
      current: enabled ? (contextSource?.() ?? null) : null,
    },
    run: { ...run },
    actions: enabled ? actions.map((action) => ({ ...action })) : [],
    actionsDropped: enabled ? actionsDropped : 0,
  }
  if (!enabled) {
    return {
      enabled,
      ...metadata,
      elapsedMs: 0,
      cpu: {
        main: { ...EMPTY_STAT, dutyPercent: 0 },
        worker: { ...EMPTY_STAT, dutyPercent: 0 },
      },
      gpu: { ...EMPTY_STAT, supported: gpuSupported },
      frames: { count: 0, averageMs: 0, p95Ms: 0, maxMs: 0, slow: 0, estimatedFps: null },
      longTasks: { ...EMPTY_STAT, supported: supportsLongTasks(), observing: false },
      memory: {
        pageUsedJSHeapBytes: null,
        pageJSHeapLimitBytes: null,
        knownTotalBytes: 0,
        known: [],
      },
      tasks: [],
      workload: [],
      scope: {
        cpu: 'Instrumented Caelestis work only. Task and aggregate p95 use the last 512 samples in recording order.',
        gpu: 'Caelestis WebGL layers only, when timer queries are available.',
        memory: 'Known Caelestis pixel and GPU buffers. Object overhead is not included.',
        pageSignals:
          'Whole-tab frame cadence, not input latency. Frame p95 uses the last 600 intervals.',
        workload: 'Per-frame Caelestis render inputs and retained work while profiling is enabled.',
        context:
          'Start and current metadata. Drawing is effective visibility; onscreen counts are render workload gauges. Browser zoom is supplied externally, never inferred from DPR or pinch scale.',
        actions:
          'Last 200 action markers in recording order, in milliseconds since reset. Trusted pointer events mark dispatch, not presentation or input latency.',
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
  const workloadRows = [...workload.entries()]
    .map(([name, metric]) => ({
      name,
      count: metric.count,
      current: metric.current,
      average: metric.count > 0 ? metric.total / metric.count : 0,
      max: metric.max,
      p95: percentile95(metric.recent),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    enabled,
    ...metadata,
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
    longTasks: {
      ...longTasks,
      supported: supportsLongTasks(),
      observing: longTaskObserver !== null,
    },
    memory: {
      pageUsedJSHeapBytes: heap.used,
      pageJSHeapLimitBytes: heap.limit,
      knownTotalBytes: known.reduce((total, source) => total + source.bytes, 0),
      known,
    },
    tasks: taskRows,
    workload: workloadRows,
    scope: {
      cpu: 'Instrumented Caelestis work only. Task and aggregate p95 use the last 512 samples in recording order.',
      gpu: 'Caelestis WebGL layers only, when timer queries are available.',
      memory: 'Known Caelestis pixel and GPU buffers. Object overhead is not included.',
      pageSignals:
        'Whole-tab frame cadence, not input latency. Frame p95 uses the last 600 intervals.',
      workload: 'Per-frame Caelestis render inputs and retained work while profiling is enabled.',
      context:
        'Start and current metadata. Drawing is effective visibility; onscreen counts are render workload gauges. Browser zoom is supplied externally, never inferred from DPR or pinch scale.',
      actions:
        'Last 200 action markers in recording order, in milliseconds since reset. Trusted pointer events mark dispatch, not presentation or input latency.',
    },
  }
}

export const profileReport = (): string =>
  JSON.stringify({ generatedAt: new Date().toISOString(), ...profileSnapshot() }, null, 2)
